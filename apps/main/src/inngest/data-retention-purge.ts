// #1590 — Retention/pruning for the fastest-growing log/event tables.
//
// The per-table purge-cron pattern is already established for audit_log (§26.5),
// forensics_log (§26.5a), request_idempotency (§7.9), etc. Several high-volume
// tables had NO pruning at all and grew monotonically. This cron sweeps them in
// one daily run — one Inngest function with a config array rather than six
// near-identical files — with a per-table, env-configurable window and BATCHED,
// BOUNDED deletes (never an unbounded `DELETE ... WHERE ts < cutoff`, which on
// the largest tables — ai_call_log is written on every AI call — could lock or
// time out).
//
// stripe_webhook_events is special: its dedup row (keyed on stripe_event_id)
// must survive forever so a replayed event is still recognised as a duplicate,
// but `raw_event` holds the full Stripe payload (customer PII) and is never read
// after processing. So past its window we NULL raw_event and keep the row,
// rather than deleting.
//
// bug_submissions / feature_requests are swept on their LIFECYCLE timestamp
// (#2033): closed_at for bugs, decided_at for feature requests. A row only
// becomes eligible once it reaches a terminal state — an open/untriaged row
// has a NULL lifecycle timestamp, which `.lt(col, cutoff)` never matches, so
// live submissions are preserved and only resolved ones age out. Both tables
// hold submitter_user_id + free-text fields, so leaving them forever was the
// silent-retention bug the old "governed by the submission lifecycle" comment
// papered over.
//
// help_sessions are reclaimed only after both child tables have been swept and
// an anti-join proves no submission survives. The NOT NULL foreign keys remain
// the final guard if a child is inserted between candidate selection and delete.
//
// Windows are conservative defaults, each overridable via env; the operator
// should confirm them against CCPA / §25 retention requirements (see PR body).
// Fail-loud: every table is attempted, per-table errors are logged and recorded
// in the audit row, and the run THROWS at the end if any table failed so the
// Inngest run surfaces as failed for alerting.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";

// Bound work per run: at most MAX_BATCHES × DELETE_BATCH rows per table. The
// remainder is caught on the next daily run — once caught up, steady-state
// volume is well under one batch.
const DELETE_BATCH = 1000;
const MAX_BATCHES = 20;

type DeleteTarget = {
  table: string;
  tsColumn: string;
  envVar: string;
  defaultDays: number;
  // PK column selected then deleted-by. Defaults to "id"; gmail_inbound_messages
  // keys on message_id (Gmail's globally-unique id), not a synthetic uuid.
  pkColumn?: string;
};

// Deliberately conservative defaults; each env var overrides at deploy time.
const DELETE_TARGETS: DeleteTarget[] = [
  { table: "ai_call_log", tsColumn: "created_at", envVar: "AI_CALL_LOG_RETENTION_DAYS", defaultDays: 180 },
  { table: "ai_tool_calls", tsColumn: "dispatched_at", envVar: "AI_TOOL_CALLS_RETENTION_DAYS", defaultDays: 180 },
  { table: "email_log", tsColumn: "created_at", envVar: "EMAIL_LOG_RETENTION_DAYS", defaultDays: 365 },
  { table: "notifications", tsColumn: "created_at", envVar: "NOTIFICATIONS_RETENTION_DAYS", defaultDays: 90 },
  { table: "attribution_touches", tsColumn: "occurred_at", envVar: "ATTRIBUTION_TOUCHES_RETENTION_DAYS", defaultDays: 365 },
  { table: "auth_attempts", tsColumn: "occurred_at", envVar: "AUTH_ATTEMPTS_RETENTION_DAYS", defaultDays: 90 },
  // #2031 — inbound customer email content (raw_payload + from/to/subject/body).
  // Mirrors the outbound analog email_log's 365d window. These hold full
  // customer email whenever a customer emails a tenant persona address.
  { table: "gmail_inbound_messages", tsColumn: "received_at", envVar: "GMAIL_INBOUND_RETENTION_DAYS", defaultDays: 365, pkColumn: "message_id" },
  { table: "inbound_emails", tsColumn: "received_at", envVar: "INBOUND_EMAILS_RETENTION_DAYS", defaultDays: 365 },
  // #2033 — lifecycle-driven purge: only rows that reached a terminal state
  // (closed_at / decided_at set) age out; open rows keep a NULL ts and are
  // never matched. 365d after close mirrors email_log's content window.
  { table: "bug_submissions", tsColumn: "closed_at", envVar: "BUG_SUBMISSIONS_RETENTION_DAYS", defaultDays: 365 },
  { table: "feature_requests", tsColumn: "decided_at", envVar: "FEATURE_REQUESTS_RETENTION_DAYS", defaultDays: 365 },
];

// stripe_webhook_events raw_event PII scrub window.
const STRIPE_RAW_EVENT_ENV = "STRIPE_WEBHOOK_RAW_EVENT_RETENTION_DAYS";
const STRIPE_RAW_EVENT_DEFAULT_DAYS = 90;
const HELP_SESSIONS_ENV = "HELP_SESSIONS_RETENTION_DAYS";
const HELP_SESSIONS_DEFAULT_DAYS = 365;

export function resolveWindowDays(envVar: string, defaultDays: number): number {
  const raw = Number(process.env[envVar] ?? defaultDays);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultDays;
}

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

type TableResult = { table: string; affected: number; window_days: number; error?: string };

async function purgeTable(
  svc: ReturnType<typeof createServiceRoleClient>,
  target: DeleteTarget,
): Promise<TableResult> {
  const windowDays = resolveWindowDays(target.envVar, target.defaultDays);
  const cutoff = cutoffIso(windowDays);
  const pk = target.pkColumn ?? "id";
  // Alias the PK to `id` so the row-mapping + delete below stay pk-agnostic.
  const selectExpr = pk === "id" ? "id" : `id:${pk}`;
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    // Select a bounded slice of expired PKs, then delete by PK. A raw
    // `DELETE ... WHERE ts < cutoff` is unbounded and can lock the whole
    // table on the largest ones; batching keeps each statement small.
    const { data: rows, error: selErr } = await svc
      .from(target.table)
      .select(selectExpr)
      .lt(target.tsColumn, cutoff)
      .limit(DELETE_BATCH);
    // #1722 — THROW (don't return) on a DB error so the wrapping step.run rejects
    // and Inngest retries the step with backoff. Returning the error resolves the
    // step non-throwing, which memoizes a one-off transient blip for the whole run.
    // Re-selecting after a partial drain is safe: already-deleted rows can't match.
    if (selErr) {
      throw new Error(`data-retention-purge: ${target.table} select failed: ${selErr.message}`);
    }
    // Cast through unknown: the dynamic aliased select string (`id:${pk}`)
    // defeats supabase-js's literal-based row typing, which otherwise widens
    // to its error branch. The shape is `{ id }` for every target here.
    const ids = ((rows ?? []) as unknown as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) break;

    const { count, error: delErr } = await svc
      .from(target.table)
      .delete({ count: "exact" })
      .in(pk, ids);
    if (delErr) {
      throw new Error(`data-retention-purge: ${target.table} delete failed: ${delErr.message}`);
    }
    deleted += count ?? ids.length;
    if (ids.length < DELETE_BATCH) break;
  }

  return { table: target.table, affected: deleted, window_days: windowDays };
}

async function purgeOrphanedHelpSessions(
  svc: ReturnType<typeof createServiceRoleClient>,
): Promise<TableResult> {
  const windowDays = resolveWindowDays(HELP_SESSIONS_ENV, HELP_SESSIONS_DEFAULT_DAYS);
  const cutoff = cutoffIso(windowDays);
  let deleted = 0;

  // serial-await-ok: each batch must delete its selected IDs before selecting the next batch.
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { data: rows, error: selErr } = await svc
      // d091-allow:service-role-tenant global retention sweep intentionally spans every tenant.
      .from("help_sessions")
      .select("id,bug_submissions!left(id),feature_requests!left(id)")
      .lt("started_at", cutoff)
      .is("bug_submissions", null)
      .is("feature_requests", null)
      .limit(DELETE_BATCH);
    if (selErr) {
      throw new Error(`data-retention-purge: help_sessions select failed: ${selErr.message}`);
    }
    const ids = ((rows ?? []) as unknown as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) break;

    const { count, error: delErr } = await svc
      // d091-allow:service-role-tenant candidates came from the global retention query above.
      .from("help_sessions")
      .delete({ count: "exact" })
      .in("id", ids);
    if (delErr) {
      throw new Error(`data-retention-purge: help_sessions delete failed: ${delErr.message}`);
    }
    deleted += count ?? ids.length;
    if (ids.length < DELETE_BATCH) break;
  }

  return { table: "help_sessions", affected: deleted, window_days: windowDays };
}

async function scrubStripeRawEvents(
  svc: ReturnType<typeof createServiceRoleClient>,
): Promise<TableResult> {
  const windowDays = resolveWindowDays(STRIPE_RAW_EVENT_ENV, STRIPE_RAW_EVENT_DEFAULT_DAYS);
  const cutoff = cutoffIso(windowDays);
  let scrubbed = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { data: rows, error: selErr } = await svc
      .from("stripe_webhook_events")
      .select("id")
      .lt("created_at", cutoff)
      .not("raw_event", "is", null)
      .limit(DELETE_BATCH);
    // #1722 — throw on error so the step retries (see purgeTable). Re-selecting is
    // safe: the `.not("raw_event","is",null)` filter excludes already-scrubbed rows.
    if (selErr) {
      throw new Error(`data-retention-purge: stripe_webhook_events select failed: ${selErr.message}`);
    }
    const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) break;

    // Keep the dedup row (stripe_event_id); null only the PII-bearing payload.
    const { error: updErr } = await svc
      .from("stripe_webhook_events")
      .update({ raw_event: null })
      .in("id", ids);
    if (updErr) {
      throw new Error(`data-retention-purge: stripe_webhook_events scrub failed: ${updErr.message}`);
    }
    scrubbed += ids.length;
    if (ids.length < DELETE_BATCH) break;
  }

  return { table: "stripe_webhook_events.raw_event", affected: scrubbed, window_days: windowDays };
}

export const dataRetentionPurge = inngest.createFunction(
  {
    id: "data-retention-purge",
    triggers: [{ cron: "30 4 * * *" }], // daily 04:30 UTC — after audit-log purge (04:00)
  },
  async ({ step }) => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      // #1722 — wrap in a step so a function retry replays the memoized insert
      // instead of writing a second benign skip-marker row.
      await step.run("staging-skip-marker", () =>
        safeAwait(
          svc.from("staging_cron_skips").insert({ cron_id: "data-retention-purge" }),
          "staging_cron_skips.insert",
        ),
      );
      return { skipped_for_staging: true };
    }

    // Each table purge and the audit write run in their own memoized step.
    //
    // #1722 — purgeTable/scrubStripeRawEvents now THROW on a DB error, so a
    // failing step rejects and Inngest retries THAT step with backoff — a
    // transient blip on one table recovers within the run instead of being
    // memoized as a permanent failure (the old return-the-error shape locked a
    // one-off connection reset in for the whole run). A step that still fails
    // after its retries is caught here so the other tables are still swept and
    // the failure is recorded in the audit row. Completed tables stay memoized,
    // so the terminal fail-loud retry never re-deletes them (D-091 Inngest
    // retry-safety).
    const results: TableResult[] = [];
    for (const target of DELETE_TARGETS) {
      try {
        results.push(await step.run(`purge-${target.table}`, () => purgeTable(svc, target)));
      } catch (err) {
        results.push({
          table: target.table,
          affected: 0,
          window_days: resolveWindowDays(target.envVar, target.defaultDays),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      results.push(await step.run("purge-help_sessions", () => purgeOrphanedHelpSessions(svc)));
    } catch (err) {
      results.push({
        table: "help_sessions",
        affected: 0,
        window_days: resolveWindowDays(HELP_SESSIONS_ENV, HELP_SESSIONS_DEFAULT_DAYS),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      results.push(await step.run("purge-stripe_webhook_events", () => scrubStripeRawEvents(svc)));
    } catch (err) {
      results.push({
        table: "stripe_webhook_events.raw_event",
        affected: 0,
        window_days: resolveWindowDays(STRIPE_RAW_EVENT_ENV, STRIPE_RAW_EVENT_DEFAULT_DAYS),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const failures = results.filter((r) => r.error);

    await step.run("write-audit-log", async () => {
      await writeAuditLog({
        actor_type: "system",
        action: failures.length > 0 ? "data_retention_purge_partial_failure" : "data_retention_purge",
        resource_type: "retention",
        changes: {
          results: results.map((r) => ({ table: r.table, affected: r.affected, window_days: r.window_days, error: r.error ?? null })),
        },
      });
    });

    // Fail loud: any table error marks the whole run failed so alerting fires,
    // but only after every table was attempted (one bad table can't mask the
    // others' work).
    if (failures.length > 0) {
      throw new Error(
        `data-retention-purge: ${failures.length} table(s) failed: ${failures
          .map((f) => `${f.table} (${f.error})`)
          .join("; ")}`,
      );
    }

    return { results };
  },
);

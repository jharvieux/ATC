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
// help_sessions is intentionally EXEMPT: bug_submissions and feature_requests
// carry a NOT NULL FK to help_sessions(id), so deleting a session would either
// violate the FK or orphan a submission that has its own (longer) retention.
// Its retention is governed by the submission lifecycle, not this sweep.
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
};

// Deliberately conservative defaults; each env var overrides at deploy time.
const DELETE_TARGETS: DeleteTarget[] = [
  { table: "ai_call_log", tsColumn: "created_at", envVar: "AI_CALL_LOG_RETENTION_DAYS", defaultDays: 180 },
  { table: "ai_tool_calls", tsColumn: "dispatched_at", envVar: "AI_TOOL_CALLS_RETENTION_DAYS", defaultDays: 180 },
  { table: "email_log", tsColumn: "created_at", envVar: "EMAIL_LOG_RETENTION_DAYS", defaultDays: 365 },
  { table: "notifications", tsColumn: "created_at", envVar: "NOTIFICATIONS_RETENTION_DAYS", defaultDays: 90 },
  { table: "attribution_touches", tsColumn: "occurred_at", envVar: "ATTRIBUTION_TOUCHES_RETENTION_DAYS", defaultDays: 365 },
  { table: "auth_attempts", tsColumn: "occurred_at", envVar: "AUTH_ATTEMPTS_RETENTION_DAYS", defaultDays: 90 },
];

// stripe_webhook_events raw_event PII scrub window.
const STRIPE_RAW_EVENT_ENV = "STRIPE_WEBHOOK_RAW_EVENT_RETENTION_DAYS";
const STRIPE_RAW_EVENT_DEFAULT_DAYS = 90;

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
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    // Select a bounded slice of expired PKs, then delete by id. A raw
    // `DELETE ... WHERE ts < cutoff` is unbounded and can lock the whole
    // table on the largest ones; batching keeps each statement small.
    const { data: rows, error: selErr } = await svc
      .from(target.table)
      .select("id")
      .lt(target.tsColumn, cutoff)
      .limit(DELETE_BATCH);
    if (selErr) {
      console.error(`[data-retention-purge] ${target.table} select failed:`, selErr.message);
      return { table: target.table, affected: deleted, window_days: windowDays, error: selErr.message };
    }
    const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) break;

    const { count, error: delErr } = await svc
      .from(target.table)
      .delete({ count: "exact" })
      .in("id", ids);
    if (delErr) {
      console.error(`[data-retention-purge] ${target.table} delete failed:`, delErr.message);
      return { table: target.table, affected: deleted, window_days: windowDays, error: delErr.message };
    }
    deleted += count ?? ids.length;
    if (ids.length < DELETE_BATCH) break;
  }

  return { table: target.table, affected: deleted, window_days: windowDays };
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
    if (selErr) {
      console.error("[data-retention-purge] stripe_webhook_events select failed:", selErr.message);
      return { table: "stripe_webhook_events.raw_event", affected: scrubbed, window_days: windowDays, error: selErr.message };
    }
    const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) break;

    // Keep the dedup row (stripe_event_id); null only the PII-bearing payload.
    const { error: updErr } = await svc
      .from("stripe_webhook_events")
      .update({ raw_event: null })
      .in("id", ids);
    if (updErr) {
      console.error("[data-retention-purge] stripe_webhook_events raw_event scrub failed:", updErr.message);
      return { table: "stripe_webhook_events.raw_event", affected: scrubbed, window_days: windowDays, error: updErr.message };
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
  async () => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await safeAwait(
        svc.from("staging_cron_skips").insert({ cron_id: "data-retention-purge" }),
        "staging_cron_skips.insert",
      );
      return { skipped_for_staging: true };
    }

    const results: TableResult[] = [];
    for (const target of DELETE_TARGETS) {
      results.push(await purgeTable(svc, target));
    }
    results.push(await scrubStripeRawEvents(svc));

    const failures = results.filter((r) => r.error);

    await writeAuditLog({
      actor_type: "system",
      action: failures.length > 0 ? "data_retention_purge_partial_failure" : "data_retention_purge",
      resource_type: "retention",
      changes: {
        results: results.map((r) => ({ table: r.table, affected: r.affected, window_days: r.window_days, error: r.error ?? null })),
      },
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

// §23.7 / #1611 — Hourly purge of expired email_retry_content rows.
//
// email_retry_content stores rendered email HTML (PII) so a soft bounce can
// re-send verbatim. The retry chain deletes a row when it terminates, but the
// vast majority of sends deliver fine and never bounce — their stored payload
// is never touched by the chain. This cron is the PII-retention backstop: it
// deletes any row past its expires_at (set to send-time + 7 days).

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

// Bound work per run: at most MAX_BATCHES × DELETE_BATCH rows. The remainder is
// caught on the next hourly run — steady-state volume is well under one batch.
const DELETE_BATCH = 1000;
const MAX_BATCHES = 20;

export const emailRetryContentPurge = inngest.createFunction(
  {
    id: "email-retry-content-purge",
    triggers: [{ cron: "23 * * * *" }], // hourly at :23 — TTL is 7d, so hourly keeps it tidy without thrashing
  },
  async () => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await safeAwait(
        svc.from("staging_cron_skips").insert({ cron_id: "email-retry-content-purge" }),
        "staging_cron_skips.insert",
      );
      return { skipped_for_staging: true };
    }

    // Batched select-then-delete-by-PK, looping until a batch comes back short.
    // A single `.delete().select()` is subject to PostgREST's max-rows cap, which
    // would silently leave PII rows past their TTL under volume. MAX_BATCHES caps
    // work per run; the remainder is caught on the next hourly run.
    const cutoff = new Date().toISOString();
    let purged = 0;
    let capped = false;
    // serial-await-ok: each delete must drain the selected PK batch before the next query.
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const { data: rows, error: selErr } = await svc
        // d091-allow:service-role-tenant global TTL retention sweep — deliberately cross-tenant (purge every tenant's expired PII); service-role only, PK-projected.
        .from("email_retry_content")
        .select("email_log_id")
        .lt("expires_at", cutoff)
        .limit(DELETE_BATCH);
      if (selErr) {
        throw new Error(`email_retry_content_purge_failed: ${selErr.message}`);
      }
      const ids = ((rows ?? []) as Array<{ email_log_id: string }>).map((r) => r.email_log_id);
      if (ids.length === 0) break;

      const { count, error: delErr } = await svc
        // d091-allow:service-role-tenant global TTL retention sweep — deletes by the PKs the cross-tenant select above returned; service-role only.
        .from("email_retry_content")
        .delete({ count: "exact" })
        .in("email_log_id", ids);
      if (delErr) {
        throw new Error(`email_retry_content_purge_failed: ${delErr.message}`);
      }
      purged += count ?? ids.length;
      if (ids.length < DELETE_BATCH) break;
      // Reached the batch bound with a still-full final batch → backlog remains.
      if (batch === MAX_BATCHES - 1) capped = true;
    }
    if (capped) {
      // Persistent capping means expired PII is outliving its TTL window across
      // hourly runs — operators should alert on this, not just watch it recur.
      console.warn(
        `[email-retry-content-purge] hit MAX_BATCHES=${MAX_BATCHES} (purged=${purged}); expired rows remain past TTL. The next hourly run continues, but a persistent cap means PII is outliving its retention window.`,
      );
    }

    // A provider attempt can be accepted before local finalization succeeds.
    // The queued email_log row keeps the exact request briefly so a retry can
    // replay it with the same provider key. Once its replay window expires,
    // clear that rendered payload rather than retaining recipient PII for the
    // much longer email_log retention period.
    let outboxSnapshotsPurged = 0;
    let outboxCapped = false;
    // serial-await-ok: each update must clear the selected PK batch before the next query.
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const { data: rows, error: selErr } = await svc
        // d091-allow:service-role-tenant global TTL retention sweep — deliberately cross-tenant; service-role only, PK-projected.
        .from("email_log")
        .select("id")
        .not("provider_request_body", "is", null)
        .lt("provider_snapshot_expires_at", cutoff)
        .limit(DELETE_BATCH);
      if (selErr) {
        throw new Error(`email_outbox_snapshot_purge_failed: ${selErr.message}`);
      }
      const ids = ((rows ?? []) as Array<{ id: string }>).map((row) => row.id);
      if (ids.length === 0) break;

      const { count, error: updateErr } = await svc
        // d091-allow:service-role-tenant global TTL retention sweep — updates only PKs returned by the bounded service-role query above.
        .from("email_log")
        .update({
          provider_request_body: null,
          provider_snapshot_expires_at: null,
          retry_content_snapshot: null,
        }, { count: "exact" })
        .in("id", ids);
      if (updateErr) {
        throw new Error(`email_outbox_snapshot_purge_failed: ${updateErr.message}`);
      }
      outboxSnapshotsPurged += count ?? ids.length;
      if (ids.length < DELETE_BATCH) break;
      if (batch === MAX_BATCHES - 1) outboxCapped = true;
    }
    if (outboxCapped) {
      console.warn(
        `[email-retry-content-purge] hit MAX_BATCHES=${MAX_BATCHES} while clearing queued provider snapshots (purged=${outboxSnapshotsPurged}); expired snapshots remain past TTL.`,
      );
    }

    return {
      purged,
      outbox_snapshots_purged: outboxSnapshotsPurged,
      ...(capped || outboxCapped ? { capped: true } : {}),
    };
  },
);

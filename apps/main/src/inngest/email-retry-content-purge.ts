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
    }
    return { purged };
  },
);

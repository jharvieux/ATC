// §7.9 — Daily purge of expired request_idempotency rows.
//
// The table caches API responses keyed by Idempotency-Key + route for 24h.
// Without a purge, the table grows monotonically. This cron deletes rows
// whose expires_at has passed.
//
// Cadence: hourly. The cache TTL is 24h, so hourly purge keeps the table
// within ~1h of clean state without thrashing.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

export const requestIdempotencyPurge = inngest.createFunction(
  {
    id: "request-idempotency-purge",
    triggers: [{ cron: "17 * * * *" }], // hourly at :17
  },
  async () => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await safeAwait(
        svc.from("staging_cron_skips").insert({ cron_id: "request-idempotency-purge" }),
        "staging_cron_skips.insert",
      );
      return { skipped_for_staging: true };
    }

    const { data: deleted, error } = await svc
      .from("request_idempotency")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("idempotency_key");

    if (error) {
      throw new Error(`request_idempotency_purge_failed: ${error.message}`);
    }

    const purged = Array.isArray(deleted) ? deleted.length : 0;
    return { purged };
  },
);

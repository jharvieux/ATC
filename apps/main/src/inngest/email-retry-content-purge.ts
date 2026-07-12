// §23.7 / #1611 — Daily purge of expired email_retry_content rows.
//
// email_retry_content stores rendered email HTML (PII) so a soft bounce can
// re-send verbatim. The retry chain deletes a row when it terminates, but the
// vast majority of sends deliver fine and never bounce — their stored payload
// is never touched by the chain. This cron is the PII-retention backstop: it
// deletes any row past its expires_at (set to send-time + 7 days).

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

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

    const { data: deleted, error } = await svc
      .from("email_retry_content")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("email_log_id");

    if (error) {
      throw new Error(`email_retry_content_purge_failed: ${error.message}`);
    }

    const purged = Array.isArray(deleted) ? deleted.length : 0;
    return { purged };
  },
);

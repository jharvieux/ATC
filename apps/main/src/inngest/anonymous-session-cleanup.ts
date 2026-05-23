// §25.2 — 60-day cleanup of anonymous_sessions rows.
//
// Distinct from BP24's anonymous-chat-counter-cleanup (7-day, per-message
// counters): this cron is the privacy/GDPR-aligned outer bound on the
// session record itself. If an anonymous session never converted to an
// authenticated user, drop it after 60 days of inactivity.
//
// Skipped in staging when STAGING_MODE=true (writes to staging_cron_skips).

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const anonymousSessionCleanup = inngest.createFunction(
  {
    id: "anonymous-session-cleanup",
    triggers: [{ cron: "0 4 * * *" }], // daily 04:00 UTC
  },
  async () => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await svc.from("staging_cron_skips").insert({
        cron_id: "anonymous-session-cleanup",
      });
      return { skipped_for_staging: true };
    }

    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await svc
      .from("anonymous_sessions")
      .delete({ count: "exact" })
      .lt("last_active_at", cutoff);
    if (error) {
      console.error("[anonymous-session-cleanup] delete failed:", error.message);
      return { deleted: 0, error: error.message };
    }
    return { deleted: count ?? 0 };
  },
);

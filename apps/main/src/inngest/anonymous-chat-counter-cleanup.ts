// §24.8 — Nightly cleanup of anonymous_chat_counters older than 7 days.
//
// Privacy contract: IP addresses are PII in some jurisdictions (GDPR).
// 7-day retention bounds exposure. Without this cron, counter rows
// accumulate indefinitely.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const anonymousChatCounterCleanup = inngest.createFunction(
  {
    id: "anonymous-chat-counter-cleanup",
    triggers: [{ cron: "0 4 * * *" }], // nightly 04:00 UTC
  },
  async () => {
    const svc = createServiceRoleClient();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await svc
      .from("anonymous_chat_counters")
      .delete({ count: "exact" })
      .lt("last_message_at", cutoff);
    if (error) {
      console.error("[anonymous-chat-counter-cleanup] delete failed:", error.message);
      return { deleted: 0, error: error.message };
    }
    return { deleted: count ?? 0 };
  },
);

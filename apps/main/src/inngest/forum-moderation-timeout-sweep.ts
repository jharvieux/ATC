// §19.3 — 24-hour escalation sweep for stuck pending_moderation messages.
//
// Safety net for messages whose retry chain was lost. Runs every 15 minutes.
// Transitions status → flagged_review with moderation_decision_reason = 'moderation_timeout'.
// Uses optimistic locking on moderation_attempt_count.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { verifyEnvAtBoot } from "@/lib/env";

export const forumModerationTimeoutSweep = inngest.createFunction(
  {
    id: "forum-moderation-timeout-sweep",
    triggers: [{ cron: "*/15 * * * *" }], // every 15 minutes
  },
  async () => {
    const env = verifyEnvAtBoot();
    const svc = createServiceRoleClient();
    const now = new Date();
    const cutoff = new Date(
      now.getTime() - env.FORUM_MODERATION_RETRY_TIMEOUT_HOURS * 60 * 60 * 1000,
    );

    const { data: stale } = await svc
      .from("forum_messages")
      .select("id,moderation_attempt_count")
      .eq("status", "pending_moderation")
      .lt("pending_moderation_since", cutoff.toISOString())
      .limit(100);

    let escalated = 0;
    for (const msg of stale ?? []) {
      const { data: updated } = await svc
        .from("forum_messages")
        .update({
          status: "flagged_review",
          moderation_decision_reason: "moderation_timeout",
          pending_moderation_since: null,
          moderation_last_error: null,
        })
        .eq("id", msg.id)
        .eq("moderation_attempt_count", msg.moderation_attempt_count)
        .select("id");

      if ((updated ?? []).length > 0) escalated++;
    }

    console.log(`[forum-moderation-timeout-sweep] escalated=${escalated}`);
    return { escalated };
  },
);

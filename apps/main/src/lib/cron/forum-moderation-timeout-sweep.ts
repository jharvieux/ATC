// §19.3 — 24-hour escalation sweep for stuck pending_moderation messages.
// Runs every 15 minutes via Vercel cron (/api/cron/forum-moderation-timeout-sweep).
// Safety net for messages whose retry chain was lost. Transitions
// status → flagged_review with moderation_decision_reason = 'moderation_timeout'.
// Uses optimistic locking on moderation_attempt_count.
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { verifyEnvAtBoot } from "@/lib/env";

export async function runForumModerationTimeoutSweep() {
  const env = verifyEnvAtBoot();
  const svc = createServiceRoleClient();
  const now = new Date();
  const cutoff = new Date(
    now.getTime() - env.FORUM_MODERATION_RETRY_TIMEOUT_HOURS * 60 * 60 * 1000,
  );

  const { data: stale, error: selectError } = await svc
    .from("forum_messages")
    .select("id,moderation_attempt_count")
    .eq("status", "pending_moderation")
    .lt("pending_moderation_since", cutoff.toISOString())
    .limit(100);
  if (selectError) throw new Error(`forum_messages select failed: ${selectError.message}`);

  let escalated = 0;
  for (const msg of stale ?? []) {
    const { data: updated, error: updateError } = await svc
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
    if (updateError) throw new Error(`forum_messages update failed: ${updateError.message}`);

    if ((updated ?? []).length > 0) escalated++;
  }

  console.log(`[forum-moderation-timeout-sweep] escalated=${escalated}`);
  return { escalated };
}

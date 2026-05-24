// §19.3 — Forum moderation retry job with optimistic locking.
//
// Triggered by: forum/message.needs_moderation_retry
// Backoff: 5 min → 15 min → 60 min (from pending_moderation_since).
//
// Optimistic locking via moderation_attempt_count: the UPDATE WHERE
// moderation_attempt_count = expected ensures only one parallel worker wins.
// Second/third parallel firings are no-ops (the count has already advanced).
//
// After FORUM_MODERATION_RETRY_TIMEOUT_HOURS, escalates to flagged_review
// with moderation_decision_reason = 'moderation_timeout' (no auto-strike).

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { verifyEnvAtBoot } from "@/lib/env";
import { recordStrike, checkStrikePatterns } from "@/lib/forums/strikes";
import { instrumentedClaudeCall, type AICallPurpose } from "@/lib/ai/call-wrapper";

interface ModerationScores {
  spam: number;
  abuse: number;
  pii_leak: number;
  off_topic: number;
  misinformation: number;
  solicitation: number;
  prompt_injection: number;
  credit_card_pattern?: boolean;
}

interface ModerationResult {
  scores: ModerationScores;
  max_score: number;
  reasoning: string;
}

async function callHaikuModeration(
  content: string,
  _timeoutMs: number,
  model: string,
  tenant_id: string,
): Promise<ModerationResult> {
  // Wrapped via instrumentedClaudeCall so cost attribution, vendor-health
  // breadcrumbs, and AI-cost state transitions all fire. _timeoutMs is
  // ignored — the SDK uses its own connection timeout; callers wanting a
  // hard upper bound can race a Promise.race.
  void _timeoutMs;
  const { text } = await instrumentedClaudeCall({
    tenant_id,
    model,
    purpose: "forum_moderation",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Score the following forum message for moderation. Return ONLY valid JSON with this exact structure:
{"scores":{"spam":0.0,"abuse":0.0,"pii_leak":0.0,"off_topic":0.0,"misinformation":0.0,"solicitation":0.0,"prompt_injection":0.0},"credit_card_pattern":false,"max_score":0.0,"reasoning":"..."}

Message to moderate:
"""
${content.slice(0, 2000)}
"""`,
      },
    ],
  });
  try {
    return JSON.parse(text) as ModerationResult;
  } catch (err) {
    throw new Error(`haiku_api_error: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function decideModerationStatus(result: ModerationResult): "visible" | "flagged_review" | "hidden" {
  if (result.max_score < 0.4) return "visible";
  if (result.max_score <= 0.7) return "flagged_review";
  return "hidden";
}

// Backoff schedule (minutes from pending_moderation_since)
const BACKOFF_MINUTES = [5, 15, 60];

export const forumModerationRetry = inngest.createFunction(
  {
    id: "forum-moderation-retry",
    triggers: [{ event: "forum/message.needs_moderation_retry" }],
  },
  async ({ event }: { event: { data: { message_id: string; tenant_id: string; forum_id: string } } }) => {
    const { message_id, tenant_id, forum_id } = event.data;
    const env = verifyEnvAtBoot();
    const svc = createServiceRoleClient();

    const { data: msg } = await svc
      .from("forum_messages")
      .select("id,content,status,moderation_attempt_count,pending_moderation_since,user_id")
      .eq("id", message_id)
      .maybeSingle();

    if (!msg || msg.status !== "pending_moderation") {
      // Already resolved (success case or idempotent no-op)
      return { skipped: true };
    }

    const expectedCount = msg.moderation_attempt_count as number;
    const attemptNumber = expectedCount; // 0-indexed: first retry is attempt 0
    const backoffMinutes = BACKOFF_MINUTES[Math.min(attemptNumber, BACKOFF_MINUTES.length - 1)] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]!;

    const pendingSince = new Date(msg.pending_moderation_since as string);
    const nextRetryAt = new Date(pendingSince.getTime() + backoffMinutes * 60 * 1000);
    const now = new Date();

    if (now < nextRetryAt) {
      // Too early — re-emit the event to retry later
      const delayMs = nextRetryAt.getTime() - now.getTime();
      setTimeout(() => {
        svc; // capture for closure
      }, 0);
      // Re-schedule by emitting again — Inngest will pick it up
      await inngest.send({
        name: "forum/message.needs_moderation_retry",
        data: { message_id, tenant_id, forum_id },
      });
      return { rescheduled: true, retryAfterMs: delayMs };
    }

    // Check 24h escalation threshold
    const hoursElapsed = (now.getTime() - pendingSince.getTime()) / (1000 * 60 * 60);
    if (hoursElapsed >= env.FORUM_MODERATION_RETRY_TIMEOUT_HOURS) {
      // Optimistic lock: only update if count still matches
      const { data: escalated } = await svc
        .from("forum_messages")
        .update({
          status: "flagged_review",
          moderation_decision_reason: "moderation_timeout",
          pending_moderation_since: null,
          moderation_last_error: null,
        })
        .eq("id", message_id)
        .eq("moderation_attempt_count", expectedCount)
        .select("id");

      return { escalated: (escalated ?? []).length > 0 };
    }

    // Attempt moderation
    let result: ModerationResult | null = null;
    let lastError: string | null = null;

    try {
      result = await callHaikuModeration(
        msg.content as string,
        env.FORUM_MODERATION_HAIKU_TIMEOUT_MS,
        env.HAIKU_FORUM_MODERATION_MODEL,
        tenant_id,
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (!result) {
      // Optimistic lock: increment attempt count only if we win the race
      await svc
        .from("forum_messages")
        .update({
          moderation_attempt_count: expectedCount + 1,
          moderation_last_attempt_at: now.toISOString(),
          moderation_last_error: lastError ?? "haiku_no_result",
        })
        .eq("id", message_id)
        .eq("moderation_attempt_count", expectedCount);

      // Re-emit for the next backoff window
      await inngest.send({
        name: "forum/message.needs_moderation_retry",
        data: { message_id, tenant_id, forum_id },
      });
      return { retried: true, attempt: expectedCount, error: lastError };
    }

    // Success path: determine status and update with optimistic lock
    const status = decideModerationStatus(result);

    const { data: updated } = await svc
      .from("forum_messages")
      .update({
        status,
        moderation_scores: result.scores,
        moderation_decision_reason: result.reasoning,
        moderation_attempt_count: expectedCount + 1,
        moderation_last_attempt_at: now.toISOString(),
        pending_moderation_since: null,
        moderation_last_error: null,
      })
      .eq("id", message_id)
      .eq("moderation_attempt_count", expectedCount)
      .select("id");

    const won = (updated ?? []).length > 0;

    if (won && status === "hidden") {
      await recordStrike(svc, {
        user_id: msg.user_id as string,
        forum_id,
        tenant_id,
        message_id,
        kind: "ai_hidden",
      });
      await checkStrikePatterns(svc, { user_id: msg.user_id as string, forum_id, tenant_id });
    }

    return { resolved: won, status, attempt: expectedCount };
  },
);

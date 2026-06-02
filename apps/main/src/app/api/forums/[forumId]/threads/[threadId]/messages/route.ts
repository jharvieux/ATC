// §19.3–19.4 — Forum message post with fail-closed Haiku moderation contract.
//
// POST /api/forums/:forumId/threads/:threadId/messages
//   Body: { content, parent_message_id? }
//
// Moderation status decision per max_score:
//   < 0.4   → visible
//   0.4–0.7 → flagged_review
//   > 0.7   → hidden
//
// Haiku failure → pending_moderation (fail-closed, emit retry event)
// PII pii_leak > 0.95 + credit_card_pattern → hidden + audit

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { canPost } from "@/lib/forums/permissions";
import { recordStrike, checkStrikePatterns } from "@/lib/forums/strikes";
import { inngest } from "@/inngest/client";
import { verifyEnvAtBoot } from "@/lib/env";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";
import { decideModerationStatus } from "@/lib/forums/moderation-status";
import { respondToAuthError } from "@/lib/auth/respond";

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
  timeoutMs: number,
  model: string,
): Promise<ModerationResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: `Score the following forum message for moderation. Return ONLY valid JSON with this exact structure:
{"scores":{"spam":0.0,"abuse":0.0,"pii_leak":0.0,"off_topic":0.0,"misinformation":0.0,"solicitation":0.0,"prompt_injection":0.0},"credit_card_pattern":false,"max_score":0.0,"reasoning":"..."}

Scores are 0.0–1.0. credit_card_pattern is true only if the message contains a credit card number pattern.

Message to moderate:
"""
${content.slice(0, 2000)}
"""`,
          },
        ],
      }),
    });

    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => res.status.toString());
      throw new Error(`haiku_api_error: ${res.status} ${errText.slice(0, 200)}`);
    }

    const body = await res.json() as { content?: { text?: string }[] };
    const raw = body.content?.[0]?.text ?? "";
    const parsed = JSON.parse(raw) as ModerationResult & { credit_card_pattern?: boolean };
    if (parsed.credit_card_pattern !== undefined) {
      (parsed.scores as ModerationScores & { credit_card_pattern?: boolean }).credit_card_pattern = parsed.credit_card_pattern;
    }
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function POST(
  req: Request,
  props: { params: Promise<{ forumId: string; threadId: string }> }
): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "post_message" });
    const env = verifyEnvAtBoot();
    const svc = createServiceRoleClient();

    const { forumId, threadId } = params;

    // Load forum + thread
    const { data: forum } = await svc.from("forums").select("*").eq("id", forumId).eq("tenant_id", ctx.tenant_id).single();
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

    // D-091 Pattern 5 — add tenant_id filter (forum_id was already filtered
    // to a tenant-owned forum above, but the explicit tenant_id makes the
    // query self-contained).
    const { data: thread } = await svc.from("forum_threads").select("*").eq("id", threadId).eq("forum_id", forumId).eq("tenant_id", ctx.tenant_id).single();
    if (!thread) return Response.json({ error: "thread_not_found" }, { status: 404 });

    // §19.10 — Post-sailing forum read-only mode. Once the group has
    // sailed (sailed_at IS NOT NULL OR status='sailed'), the forum
    // transitions to read-only. Returns 410 Gone per the spec.
    const { data: group } = await svc
      .from("groups")
      .select("sailed_at, status")
      .eq("id", (forum as { group_id: string }).group_id)
      .maybeSingle();
    const sailed =
      group &&
      ((group as { sailed_at: string | null; status: string }).sailed_at !== null ||
        (group as { sailed_at: string | null; status: string }).status === "sailed");
    if (sailed) {
      return Response.json(
        { error: "forum_read_only_post_sailing" },
        { status: 410 },
      );
    }

    // Load mute state for this user
    const { data: muteState } = await svc
      .from("forum_user_state")
      .select("is_muted,muted_until")
      .eq("forum_id", forumId)
      .eq("user_id", user.id)
      .maybeSingle();

    // Load invitation for rsvp_state check
    const { data: invitation } = await svc
      .from("invitations")
      .select("rsvp_state")
      .eq("invitee_email", user.auth_user_id)
      .maybeSingle();

    const userPerms = {
      id: user.id,
      role: "member",
      is_coordinator: forum.coordinator_user_id === user.id,
    };

    if (!canPost({ user: userPerms, forum, thread, muteState, invitation })) {
      return Response.json({ error: "posting_not_permitted" }, { status: 403 });
    }

    const body = await req.json() as { content: string; parent_message_id?: string };
    const { content, parent_message_id } = body;

    if (!content?.trim()) {
      return Response.json({ error: "content_required" }, { status: 400 });
    }

    // Audit pass 2, Finding 5: parent_message_id was inserted verbatim with
    // no scope check, so a member of tenant A's forum could attach their
    // reply to ANY message UUID (cross-tenant, cross-forum, cross-thread).
    // Require the parent to exist in the SAME thread + tenant.
    if (parent_message_id) {
      const { data: parent } = await svc
        .from("forum_messages")
        .select("id")
        .eq("id", parent_message_id)
        .eq("thread_id", threadId)
        .eq("tenant_id", ctx.tenant_id)
        .maybeSingle();
      if (!parent) {
        return Response.json(
          { error: "parent_message_not_in_thread" },
          { status: 422 },
        );
      }
    }

    // Insert with status 'pending' first
    const { data: msg, error: insertErr } = await svc
      .from("forum_messages")
      .insert({
        thread_id: threadId,
        tenant_id: ctx.tenant_id,
        forum_id: forumId,
        user_id: user.id,
        parent_message_id: parent_message_id ?? null,
        content,
        status: "pending",
      })
      .select()
      .single();

    if (insertErr || !msg) {
      console.error("[forum-messages] insert error:", insertErr?.message);
      return Response.json({ error: "insert_failed" }, { status: 500 });
    }

    // Synchronous Haiku moderation
    let moderationResult: ModerationResult | null = null;
    let moderationError: string | null = null;

    try {
      moderationResult = await callHaikuModeration(
        content,
        env.FORUM_MODERATION_HAIKU_TIMEOUT_MS,
        env.HAIKU_FORUM_MODERATION_MODEL,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("aborted") || errMsg.includes("timeout")) {
        moderationError = "haiku_timeout";
      } else if (errMsg.startsWith("haiku_api_error")) {
        moderationError = errMsg;
        if (errMsg.includes("401") || errMsg.includes("529")) {
          // Auth failure or quota exceeded — platform-level alert needed
          console.error("[forum-moderation] PLATFORM ALERT: Haiku auth/quota error:", errMsg);
        }
      } else {
        moderationError = `haiku_malformed_response: ${errMsg.slice(0, 200)}`;
        // Engineering attention for malformed responses
        console.error("[forum-moderation] ENGINEERING ALERT: malformed Haiku response for message", msg.id);
        await writeAuditLog({
          tenant_id: ctx.tenant_id,
          actor_type: "system",
          action: "forum.moderation_engineering_alert",
          resource_type: "forum_message",
          resource_id: msg.id,
          changes: { error: moderationError },
        });
      }
    }

    if (moderationError || !moderationResult) {
      // Fail-closed: put into pending_moderation
      // D-091 Pattern 5 — tenant_id filter as defense-in-depth.
      await safeAwait(svc.from("forum_messages").update({
        status: "pending_moderation",
        pending_moderation_since: new Date().toISOString(),
        moderation_last_error: moderationError ?? "haiku_no_result",
      }).eq("id", msg.id).eq("tenant_id", ctx.tenant_id), "forum_messages.update");

      await inngest.send({
        name: "forum/message.needs_moderation_retry",
        data: { message_id: msg.id, tenant_id: ctx.tenant_id, forum_id: forumId },
      });

      return Response.json({ ...msg, status: "pending_moderation" }, { status: 201 });
    }

    // Decide status
    let status: "visible" | "flagged_review" | "hidden" = decideModerationStatus(moderationResult.max_score);

    // PII zero-tolerance: credit card pattern override
    const scores = moderationResult.scores as ModerationScores & { credit_card_pattern?: boolean };
    if (scores.pii_leak > 0.95 && scores.credit_card_pattern) {
      status = "hidden";
      await writeAuditLog({
        tenant_id: ctx.tenant_id,
        actor_type: "system",
        action: "forum.pii_quarantine",
        resource_type: "forum_message",
        resource_id: msg.id,
        changes: { reason: "credit_card_pattern_detected" },
      });
    }

    await safeAwait(svc.from("forum_messages").update({
      status,
      moderation_scores: moderationResult.scores,
      moderation_decision_reason: moderationResult.reasoning,
    }).eq("id", msg.id).eq("tenant_id", ctx.tenant_id), "forum_messages.update");

    // Strike only on hidden (not flagged_review per §19.9)
    if (status === "hidden") {
      await recordStrike(svc, {
        user_id: user.id,
        forum_id: forumId,
        tenant_id: ctx.tenant_id,
        message_id: msg.id,
        kind: "ai_hidden",
      });
      await checkStrikePatterns(svc, {
        user_id: user.id,
        forum_id: forumId,
        tenant_id: ctx.tenant_id,
      });
    }

    return Response.json({ ...msg, status, moderation_scores: moderationResult.scores }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

// §19.3–19.4 — Shared forum-message insert + fail-closed Haiku-moderation
// pipeline. Factored out of the staff-facing POST route so the guest
// (invitee-token) POST route can reuse the exact same moderation contract
// instead of special-casing or drifting from it — see
// apps/main/src/app/api/forums/[forumId]/threads/[threadId]/messages/route.ts
// (staff) and apps/main/src/app/api/groups/invite/[token]/forum/threads/
// [threadId]/messages/route.ts (guest), both of which call this.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import { decideModerationStatus } from "@/lib/forums/moderation-status";
import { recordStrike, checkStrikePatterns } from "@/lib/forums/strikes";
import { writeAuditLog } from "@/lib/audit/write";
import { inngest } from "@/inngest/client";

// A message is authored by exactly one of a user row or a guest invitation
// (forum_messages_author_xor, migration 20260717000000) — recordStrike /
// checkStrikePatterns key off user_id, so guest-authored hidden messages
// don't yet get strike-tracked (forum_strikes/forum_user_state have no
// invitation-author equivalent; tracked as a follow-up, see PR description).
export type MessageAuthor = { user_id: string } | { invitation_id: string };

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

export async function insertAndModerateForumMessage(
  svc: SupabaseClient,
  args: {
    thread_id: string;
    tenant_id: string;
    forum_id: string;
    author: MessageAuthor;
    content: string;
    parent_message_id?: string | null | undefined;
    haikuTimeoutMs: number;
    haikuModel: string;
  },
): Promise<{ body: Record<string, unknown>; status: number }> {
  const { thread_id, tenant_id, forum_id, author, content, parent_message_id, haikuTimeoutMs, haikuModel } = args;

  if (!content?.trim()) {
    return { body: { error: "content_required" }, status: 400 };
  }

  // callHaikuModeration only scores the first 2000 chars — cap content at
  // exactly that window so nothing inserted can fall outside what's scored.
  if (content.length > 2_000) {
    return { body: { error: "content_too_long" }, status: 400 };
  }

  // Audit pass 2, Finding 5: a reply's parent_message_id must resolve to a
  // message in the SAME thread + tenant — otherwise a caller could attach
  // their reply to any message UUID (cross-tenant, cross-forum, cross-thread).
  if (parent_message_id) {
    const { data: parent } = await svc
      .from("forum_messages")
      .select("id")
      .eq("id", parent_message_id)
      .eq("thread_id", thread_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (!parent) {
      return { body: { error: "parent_message_not_in_thread" }, status: 422 };
    }
  }

  const { data: msg, error: insertErr } = await svc
    .from("forum_messages")
    .insert({
      thread_id,
      tenant_id,
      forum_id,
      ...author,
      parent_message_id: parent_message_id ?? null,
      content,
      status: "pending",
    })
    .select()
    .single();

  if (insertErr || !msg) {
    console.error("[forum-messages] insert error:", insertErr?.message);
    return { body: { error: "insert_failed" }, status: 500 };
  }

  let moderationResult: ModerationResult | null = null;
  let moderationError: string | null = null;

  try {
    moderationResult = await callHaikuModeration(content, haikuTimeoutMs, haikuModel);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("aborted") || errMsg.includes("timeout")) {
      moderationError = "haiku_timeout";
    } else if (errMsg.startsWith("haiku_api_error")) {
      moderationError = errMsg;
      if (errMsg.includes("401") || errMsg.includes("529")) {
        console.error("[forum-moderation] PLATFORM ALERT: Haiku auth/quota error:", errMsg);
      }
    } else {
      moderationError = `haiku_malformed_response: ${errMsg.slice(0, 200)}`;
      console.error("[forum-moderation] ENGINEERING ALERT: malformed Haiku response for message", msg.id);
      await writeAuditLog({
        tenant_id,
        actor_type: "system",
        action: "forum.moderation_engineering_alert",
        resource_type: "forum_message",
        resource_id: msg.id,
        changes: { error: moderationError },
      });
    }
  }

  if (moderationError || !moderationResult) {
    // Fail-closed: put into pending_moderation for the async retry job.
    await safeAwait(svc.from("forum_messages").update({
      status: "pending_moderation",
      pending_moderation_since: new Date().toISOString(),
      moderation_last_error: moderationError ?? "haiku_no_result",
    }).eq("id", msg.id).eq("tenant_id", tenant_id), "forum_messages.update");

    await inngest.send({
      name: "forum/message.needs_moderation_retry",
      data: { message_id: msg.id, tenant_id, forum_id },
    });

    return { body: { ...msg, status: "pending_moderation" }, status: 201 };
  }

  let status = decideModerationStatus(moderationResult.max_score);

  // PII zero-tolerance: credit card pattern override.
  const scores = moderationResult.scores as ModerationScores & { credit_card_pattern?: boolean };
  if (scores.pii_leak > 0.95 && scores.credit_card_pattern) {
    status = "hidden";
    await writeAuditLog({
      tenant_id,
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
  }).eq("id", msg.id).eq("tenant_id", tenant_id), "forum_messages.update");

  // Strike tracking only covers authenticated users today (forum_strikes.
  // user_id is NOT NULL) — guest-authored hidden messages skip it.
  if (status === "hidden" && "user_id" in author) {
    await recordStrike(svc, { user_id: author.user_id, forum_id, tenant_id, message_id: msg.id, kind: "ai_hidden" });
    await checkStrikePatterns(svc, { user_id: author.user_id, forum_id, tenant_id });
  }

  return { body: { ...msg, status, moderation_scores: moderationResult.scores }, status: 201 };
}

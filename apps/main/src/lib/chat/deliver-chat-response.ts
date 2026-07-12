// #1759/#1781 — final-delivery phase, extracted verbatim from handleChat.
//
// Owns the end of the turn: the escalation branch (persist escalation
// message, flip conversation status, terminal SSE events), the
// asset_id_validation hallucination-defense layer (BP39 §33.7.4), asset/
// message-id SSE events, the streaming-vs-fake-stream final emit, and the
// conversation last_message_at/message_count bump.
//
// The caller keeps the orchestration spine: generation + supervisor regen
// run BEFORE this. On return, the SSE stream is always closed.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import { runAssetIdValidationLayer } from "@/lib/ai/hallucination-defense/asset-id-validation";
import type { SupervisorOutcome } from "@/lib/supervisor/types";
import type { RetrievedAsset } from "@atc/contracts";

// The SSE events this phase emits — a structural subset of the route's
// SseEvent union, so the route's `send` is directly assignable.
export type DeliverChatResponseSseEvent =
  | { type: "delta"; text: string }
  | { type: "message_revised"; content: string }
  | { type: "message_id"; message_id: string; conversation_id: string }
  | { type: "assets"; assets: unknown[] }
  | { type: "escalation"; body: string }
  | { type: "done" };

export type DeliverChatResponseArgs = {
  svc: SupabaseClient;
  tenantId: string;
  conversationId: string;
  assistantMessageId: string;
  candidate: string;
  supervisorOutcome: SupervisorOutcome | null;
  availableAssetIds: string[];
  retrievedAssets: RetrievedAsset[];
  streamingEnabled: boolean;
  streamedAttempts: number;
  perSentenceFires: number;
  postStreamSupervisorFires: number;
  customerCurrentCount: number;
  send: (ev: DeliverChatResponseSseEvent) => Promise<void>;
  close: () => Promise<void>;
};

export async function deliverChatResponse(args: DeliverChatResponseArgs): Promise<void> {
  const {
    svc,
    tenantId,
    conversationId,
    assistantMessageId,
    supervisorOutcome,
    availableAssetIds,
    retrievedAssets,
    streamingEnabled,
    streamedAttempts,
    perSentenceFires,
    postStreamSupervisorFires,
    customerCurrentCount,
    send,
    close,
  } = args;
  let candidate = args.candidate;

  if (supervisorOutcome?.action === "escalate") {
    const escalationBody =
      "Thanks for chatting! I'm bringing in someone from the team — they'll be in touch shortly.";
    await send({ type: "escalation", body: escalationBody });
    // Persist the escalation message as a separate row so the transcript reflects it.
    await safeAwait(svc.from("messages").insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      role: "system",
      content: escalationBody,
    }), "messages.insert");
    await safeAwait(svc
      // d091-allow:service-role-tenant pre-existing debt moved verbatim from route.ts (#1759/#1781); tracked in #726/#730/#740.
      .from("conversations")
      .update({ status: "escalated", last_message_at: new Date().toISOString() })
      .eq("id", conversationId), "conversations.update");
    await send({ type: "message_id", message_id: assistantMessageId, conversation_id: conversationId });
    await send({ type: "done" });
    await close();
    return;
  }

  // BP39 §33.7.4 — asset_id_validation hallucination defense layer.
  // Strips any [[display_asset:<uuid>]] markup whose UUID wasn't in the
  // per-turn available set (or was malformed). Self-healing: caller streams
  // the sanitized output directly. Telemetry counters in `assetValidation`.
  const assetValidation = runAssetIdValidationLayer(candidate, availableAssetIds);
  const preValidationCandidate = candidate;
  candidate = assetValidation.output;
  if (assetValidation.severity === "warning") {
    console.warn("[chat] asset_id_validation stripped markup", {
      conversation_id: conversationId,
      message_id: assistantMessageId,
      dropped: assetValidation.metrics.dropped_count,
      malformed: assetValidation.metrics.malformed_count,
    });
    // Persist the sanitized content over the original candidate.
    await safeAwait(svc.from("messages").update({ content: candidate }).eq("id", assistantMessageId).eq("tenant_id", tenantId), "messages.update");
  }

  // Surface assets to the client so it can render the [[display_asset:<id>]]
  // sentinels (BP39 hyperlink approach — see MEMORY D-075).
  if (retrievedAssets.length > 0) {
    await send({ type: "assets", assets: retrievedAssets });
  }

  await send({ type: "message_id", message_id: assistantMessageId, conversation_id: conversationId });

  if (streamingEnabled) {
    // The content was streamed as it was generated. If asset_id_validation
    // changed the text (stripped hallucinated markup), tell the client to
    // replace the bubble with the sanitized version — option B continuity.
    if (candidate !== preValidationCandidate) {
      await send({ type: "message_revised", content: candidate });
    }
    if (streamedAttempts > 1 || perSentenceFires > 0 || postStreamSupervisorFires > 0) {
      console.info("[chat-stream] turn complete", {
        conversation_id: conversationId,
        streamed_attempts: streamedAttempts,
        per_sentence_fires: perSentenceFires,
        post_stream_supervisor_fires: postStreamSupervisorFires,
      });
    }
  } else {
    // Non-streaming branch — fake-stream the approved response word-by-word
    // so the client UX is identical regardless of which branch served the turn.
    const words = candidate.split(/(\s+)/);
    for (const w of words) {
      if (!w) continue;
      await send({ type: "delta", text: w });
    }
  }
  await send({ type: "done" });
  await close();

  // Bump conversation last_message_at + count.
  await safeAwait(svc
    // d091-allow:service-role-tenant pre-existing debt moved verbatim from route.ts (#1759/#1781); tracked in #726/#730/#740.
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      message_count: Math.max(1, customerCurrentCount + 1),
    })
    .eq("id", conversationId), "conversations.update");
}

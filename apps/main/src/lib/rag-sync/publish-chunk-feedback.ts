// §6.10 — Propagate chat-feedback signals to the RAG service.
//
// On a thumbs-up/down for an AI response, the main app already writes
// messages.feedback_score (§24.4). The RAG service maintains separate
// per-chunk counters (knowledge_chunk_feedback_events) which feed the
// feedback_confidence_factor at retrieval time (§6.10). This module
// publishes the per-chunk events.
//
// Best-effort: any failure here is logged but does NOT fail the parent
// feedback write. The §6.10 ranking gracefully degrades when feedback
// data is missing (treats the chunk as un-rated).
//
// #1708 decision — deliberately NOT queued to pending_rag_sync on failure
// (unlike tenant/platform-settings events). Chunk feedback is high-volume,
// individually low-value, statistical signal: a dropped event nudges one
// chunk's rolling counter, and the receiver is already replay-protected, so a
// durable retry queue + drain cron would add cost and dedup surface for no
// meaningful ranking gain. Correctness-critical replicas (tenant status,
// platform settings) keep their queue; this stays documented best-effort.

import "server-only";

import { hmacHexSign } from "@atc/contracts";

export interface PublishChunkFeedbackInput {
  message_id: string | null;
  signal_direction: "up" | "down";
  raw_weight?: number; // defaults to 1.0
  chunk_ids: string[];
}

/** Fire-and-forget by default — callers should not await unless they
 *  want the error surfaced (tests do). Returns a promise that resolves
 *  on success and resolves (not rejects) with `{ ok: false }` on
 *  failure so the caller doesn't have to handle exceptions. */
export async function publishChunkFeedback(
  input: PublishChunkFeedbackInput,
): Promise<{ ok: boolean; error?: string }> {
  if (input.chunk_ids.length === 0) {
    return { ok: true };
  }

  const ragUrl = process.env.RAG_SERVICE_URL;
  const secret = process.env.RAG_WEBHOOK_SECRET;
  if (!ragUrl || !secret) {
    console.warn("[publish-chunk-feedback] RAG_SERVICE_URL or RAG_WEBHOOK_SECRET not set — skipping");
    return { ok: false, error: "rag_env_not_set" };
  }

  const body = JSON.stringify({
    message_id: input.message_id,
    signal_direction: input.signal_direction,
    raw_weight: input.raw_weight ?? 1.0,
    chunk_ids: input.chunk_ids.slice(0, 20),
  });

  try {
    const signature = await hmacHexSign(secret, body);
    const res = await fetch(`${ragUrl.replace(/\/+$/, "")}/api/feedback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => `${res.status}`);
      console.warn("[publish-chunk-feedback] non-OK response:", res.status, text.slice(0, 200));
      return { ok: false, error: `rag_returned_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[publish-chunk-feedback] fetch failed:", message);
    return { ok: false, error: message };
  }
}

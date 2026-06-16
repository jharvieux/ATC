// §24.4 — Submit chat feedback (thumbs up/down + optional reason).
//
// Body: { message_id: string, score: -1|0|1, reason?: string }.
// Writes feedback_score and feedback_reason on the messages row. Then
// propagates the per-chunk signal to the RAG service so the §6.10
// feedback_confidence_factor at retrieval time picks it up.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { publishChunkFeedback } from "@/lib/rag-sync/publish-chunk-feedback";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Chat feedback",
      action: "post",
    });
    const body = (await req.json()) as {
      message_id?: string;
      score?: number;
      reason?: string;
    };

    const messageId = String(body.message_id ?? "");
    const score = Number(body.score);
    if (!messageId) return Response.json({ error: "missing_message_id" }, { status: 400 });
    if (![-1, 0, 1].includes(score)) {
      return Response.json({ error: "invalid_score" }, { status: 400 });
    }

    const db = tenantClient(ctx);

    // Read existing rag_chunks_used BEFORE updating so we know which
    // chunks to attribute the signal to. The §6.10 events table is
    // append-only — re-thumbing a message would queue another event,
    // which is fine (the rolling counters absorb it).
    const { data: msgRow } = await db
      .from("messages")
      .select("rag_chunks_used")
      .eq("id", messageId)
      .maybeSingle();

    const { error } = await db
      .from("messages")
      .update({
        feedback_score: score,
        feedback_reason: body.reason?.toString().slice(0, 1000) ?? null,
      })
      .eq("id", messageId);
    if (error) return dbErrorResponse(error);

    // §6.10 — Propagate to RAG. Best-effort: failure here doesn't fail
    // the parent write. The signal_direction maps from -1/+1 only;
    // score=0 means "clear my previous feedback" — no chunk event sent.
    if (score !== 0 && msgRow) {
      const rag = (msgRow as { rag_chunks_used: { ids?: string[] } | null }).rag_chunks_used;
      const chunkIds = rag?.ids ?? [];
      if (chunkIds.length > 0) {
        // allow-void-async: best-effort RAG signal; publishChunkFeedback never throws
        // (returns {ok:false} on failure) and the parent feedback write already persisted.
        void publishChunkFeedback({
          message_id: messageId,
          signal_direction: score > 0 ? "up" : "down",
          chunk_ids: chunkIds,
        });
      }
    }

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}

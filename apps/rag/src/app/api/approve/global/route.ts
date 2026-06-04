// §8.6 — POST /api/approve/global
//
// Promotes a pending_review item to a global knowledge_chunks row.
// Requires service_identifier === 'platform-admin'. Any tenant's pending
// content can be promoted to global by a platform admin.
export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { embed } from "@/lib/embeddings/openai";
import { enqueueEmbedding } from "@/lib/embeddings/batch/enqueue";
import { isEmbeddingBatchEnabled } from "@/lib/embeddings/feature-flag";
import { ApproveRequestSchema } from "@/lib/schemas/retrieve";
import { safeAwait } from "@/lib/db/safe-mutation";

export const POST = withServiceAuth(async (req, ctx) => {
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }

  if (ctx.service_identifier !== "platform-admin") {
    return Response.json({ error: "global_approval_requires_platform_admin" }, { status: 403 });
  }

  let body: ReturnType<typeof ApproveRequestSchema.parse>;
  try {
    const raw = await req.json();
    body = ApproveRequestSchema.parse(raw);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getRagDb();

  const { data: item, error: fetchErr } = await db
    .from("knowledge_ingestion_queue")
    .select("*")
    .eq("id", body.queue_item_id)
    .single();

  if (fetchErr || !item) {
    return Response.json({ error: "queue_item_not_found" }, { status: 404 });
  }

  if (item.processing_stage !== "pending_review") {
    return Response.json({ error: "queue_item_not_reviewable" }, { status: 409 });
  }

  const content = body.edits?.content ?? item.raw_content;
  const category = body.edits?.category ?? item.raw_metadata?.category ?? "general";

  // Embed. Batch mode (issue #686): omit embedding from insert (NULL means
  // /api/retrieve skips this chunk until reconcile fills it). Sync mode
  // computes inline.
  const batchEnabled = isEmbeddingBatchEnabled();
  let embedding: number[] | null = null;
  if (!batchEnabled) {
    try {
      embedding = await embed(content);
    } catch (err) {
      console.error("[approve/global] embedding failed:", err);
      return Response.json({ error: "embedding_failed" }, { status: 500 });
    }
  }

  const chunkFields: Record<string, unknown> = {
    content,
    content_hash: Buffer.from(content).toString("base64").slice(0, 64),
    scope: "global",
    tenant_id: null,
    category,
    source_type: item.raw_source_type,
    source_url: body.edits?.source_url ?? item.raw_source_url,
    authority_auto: item.ai_authority_score ?? 0.7,
    authority_manual_override: body.edits?.authority_override ?? null,
    authority_override_reason: body.edits?.authority_override_reason ?? null,
    expires_at: body.edits?.expires_at ?? item.edited_expires_at ?? null,
    contains_pricing: item.raw_metadata?.contains_pricing ?? false,
    status: "approved",
    approved_by_user_id: ctx.user_id ?? null,
    approved_at: new Date().toISOString(),
  };
  if (!batchEnabled && embedding) {
    chunkFields.embedding = `[${embedding.join(",")}]`;
  }

  const { data: chunk, error: chunkErr } = await db
    .from("knowledge_chunks")
    .insert(chunkFields)
    .select("id")
    .single();

  if (chunkErr || !chunk) {
    console.error("[approve/global] chunk insert failed:", chunkErr);
    return Response.json({ error: "approval_internal_error" }, { status: 500 });
  }

  if (batchEnabled) {
    try {
      await enqueueEmbedding({ chunk_id: chunk.id, content, db });
    } catch (err) {
      console.error("[approve/global] enqueue embedding failed:", err);
      return Response.json({ error: "embedding_enqueue_failed" }, { status: 500 });
    }
  }

  await safeAwait(db
    .from("knowledge_ingestion_queue")
    .update({
      processing_stage: "approved",
      promoted_to_chunk_id: chunk.id,
      promoted_at: new Date().toISOString(),
      promotion_scope: "global",
      global_reviewed_by_user_id: ctx.user_id ?? null,
      global_reviewed_at: new Date().toISOString(),
      global_review_status: "approved",
    })
    .eq("id", body.queue_item_id), "knowledge_ingestion_queue.update");

  return Response.json({ chunk_id: chunk.id });
});

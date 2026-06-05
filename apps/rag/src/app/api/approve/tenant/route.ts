// §8.6 — POST /api/approve/tenant
//
// Promotes a pending_review queue item to an approved knowledge_chunks row,
// scoped to the approving tenant. body.tenant_id must match ctx.tenant_id.
export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { embedWithUsage } from "@/lib/embeddings/openai";
import { logEmbeddingCall } from "@/lib/embeddings/cost-log";
import { enqueueEmbedding } from "@/lib/embeddings/batch/enqueue";
import { isEmbeddingBatchEnabled } from "@/lib/embeddings/feature-flag";
import { ApproveRequestSchema } from "@/lib/schemas/retrieve";
import { safeAwait } from "@/lib/db/safe-mutation";

export const POST = withServiceAuth(async (req, ctx) => {
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }

  let body: ReturnType<typeof ApproveRequestSchema.parse>;
  try {
    const raw = await req.json();
    body = ApproveRequestSchema.parse(raw);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getRagDb();

  // Load queue item
  const { data: item, error: fetchErr } = await db
    .from("knowledge_ingestion_queue")
    .select("*")
    .eq("id", body.queue_item_id)
    .single();

  if (fetchErr || !item) {
    return Response.json({ error: "queue_item_not_found" }, { status: 404 });
  }

  // Tenant ownership: the queue item must belong to this tenant
  if (item.submitted_by_tenant_id !== ctx.tenant_id) {
    return Response.json({ error: "tenant_id_mismatch_with_jwt" }, { status: 403 });
  }

  if (item.processing_stage !== "pending_review") {
    return Response.json({ error: "queue_item_not_reviewable" }, { status: 409 });
  }

  const content = body.edits?.content ?? item.raw_content;
  const category = body.edits?.category ?? item.raw_metadata?.category ?? "general";

  // Embed. Batch mode (issue #686): omit embedding from the insert (NULL
  // means /api/retrieve skips this chunk until reconcile fills it). Sync mode
  // computes inline.
  const batchEnabled = isEmbeddingBatchEnabled();
  let embedding: number[] | null = null;
  let syncEmbeddingUsage: { prompt_tokens: number; model: string; latency_ms: number } | null = null;
  if (!batchEnabled) {
    const t0 = Date.now();
    try {
      const r = await embedWithUsage(content);
      embedding = r.embedding;
      syncEmbeddingUsage = { prompt_tokens: r.prompt_tokens, model: r.model, latency_ms: Date.now() - t0 };
    } catch (err) {
      console.error("[approve/tenant] embedding failed:", err);
      return Response.json({ error: "embedding_failed" }, { status: 500 });
    }
  }

  const chunkFields: Record<string, unknown> = {
    content,
    content_hash: createHash("sha256").update(content).digest("hex"),
    scope: "tenant",
    tenant_id: ctx.tenant_id,
    category,
    source_type: item.raw_source_type,
    source_url: body.edits?.source_url ?? item.raw_source_url,
    authority_auto: item.ai_authority_score ?? 0.5,
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
    console.error("[approve/tenant] chunk insert failed:", chunkErr);
    return Response.json({ error: "approval_internal_error" }, { status: 500 });
  }

  if (!batchEnabled && syncEmbeddingUsage) {
    try {
      await logEmbeddingCall({
        db,
        tenant_id: ctx.tenant_id,
        model: syncEmbeddingUsage.model,
        source: "sync",
        input_tokens: syncEmbeddingUsage.prompt_tokens,
        latency_ms: syncEmbeddingUsage.latency_ms,
      });
    } catch (err) {
      console.warn("[approve/tenant] cost log failed:", err);
    }
  }

  if (batchEnabled) {
    try {
      // Tenant-scope approval — embedding cost attributes to ctx.tenant_id.
      await enqueueEmbedding({ chunk_id: chunk.id, content, tenant_id: ctx.tenant_id, db });
    } catch (err) {
      console.error("[approve/tenant] enqueue embedding failed:", err);
      // The queue row hasn't been flipped to 'approved' yet, so a retry
      // would re-enter this handler and insert a SECOND chunk. Delete the
      // orphan so retry is clean.
      await safeAwait(
        db.from("knowledge_chunks").delete().eq("id", chunk.id),
        "knowledge_chunks.delete.orphan_after_enqueue_failure",
      );
      return Response.json({ error: "embedding_enqueue_failed" }, { status: 500 });
    }
  }

  // Update queue row to approved
  await safeAwait(db
    .from("knowledge_ingestion_queue")
    .update({
      processing_stage: "approved",
      promoted_to_chunk_id: chunk.id,
      promoted_at: new Date().toISOString(),
      promotion_scope: "tenant",
      tenant_reviewed_by_user_id: ctx.user_id ?? null,
      tenant_reviewed_at: new Date().toISOString(),
    })
    .eq("id", body.queue_item_id), "knowledge_ingestion_queue.update");

  return Response.json({ chunk_id: chunk.id });
});

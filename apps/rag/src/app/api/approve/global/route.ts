// §8.6 — POST /api/approve/global
//
// Promotes a pending_review item to a global knowledge_chunks row.
// Requires service_identifier === 'platform-admin'. Any tenant's pending
// content can be promoted to global by a platform admin.
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
import { detectZeroTolerancePII } from "@/lib/pii/regex-prefilter";

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

  // Re-run the zero-tolerance PII pre-filter on the resolved content. Ingest
  // already screened item.raw_content, but a reviewer can override it via
  // edits.content — that override never went through the ingest screen, so
  // skipping this would let a reviewer launder PII into an approved chunk.
  // Mirrors replace-chunk/route.ts. Global scope makes this worse: the
  // laundered content becomes readable by every tenant.
  const piiResult = detectZeroTolerancePII(content);
  if (piiResult.detected) {
    return Response.json(
      { error: "zero_tolerance_pii_in_edits", categories: piiResult.categories },
      { status: 422 },
    );
  }

  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > 500_000) {
    return Response.json({ error: "content_too_large", max_bytes: 500_000, actual_bytes: contentBytes }, { status: 422 });
  }
  const category = body.edits?.category ?? item.raw_metadata?.category ?? "general";

  // Embed. Batch mode (issue #686): omit embedding from insert (NULL means
  // /api/retrieve skips this chunk until reconcile fills it). Sync mode
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
      console.error("[approve/global] embedding failed:", err);
      return Response.json({ error: "embedding_failed" }, { status: 500 });
    }
  }

  const chunkFields: Record<string, unknown> = {
    content,
    content_hash: createHash("sha256").update(content).digest("hex"),
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

  if (!batchEnabled && syncEmbeddingUsage) {
    try {
      await logEmbeddingCall({
        db,
        tenant_id: null,
        model: syncEmbeddingUsage.model,
        source: "sync",
        input_tokens: syncEmbeddingUsage.prompt_tokens,
        latency_ms: syncEmbeddingUsage.latency_ms,
      });
    } catch (err) {
      console.warn("[approve/global] cost log failed:", err);
    }
  }

  if (batchEnabled) {
    try {
      // Global-scope approval — no tenant to bill for the embedding cost.
      await enqueueEmbedding({ chunk_id: chunk.id, content, tenant_id: null, db });
    } catch (err) {
      console.error("[approve/global] enqueue embedding failed:", err);
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

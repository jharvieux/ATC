// §8.6 — POST /api/approve/tenant
//
// Promotes a pending_review queue item to an approved knowledge_chunks row,
// scoped to the approving tenant. body.tenant_id must match ctx.tenant_id.

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { embed } from "@/lib/embeddings/openai";
import { ApproveRequestSchema } from "@/lib/schemas/retrieve";

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

  // Generate embedding for the final content
  let embedding: number[];
  try {
    embedding = await embed(content);
  } catch (err) {
    console.error("[approve/tenant] embedding failed:", err);
    return Response.json({ error: "embedding_failed" }, { status: 500 });
  }

  // Insert into knowledge_chunks
  const { data: chunk, error: chunkErr } = await db
    .from("knowledge_chunks")
    .insert({
      content,
      content_hash: Buffer.from(content).toString("base64").slice(0, 64),
      embedding: `[${embedding.join(",")}]`,
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
    })
    .select("id")
    .single();

  if (chunkErr || !chunk) {
    console.error("[approve/tenant] chunk insert failed:", chunkErr);
    return Response.json({ error: "approval_internal_error" }, { status: 500 });
  }

  // Update queue row to approved
  await db
    .from("knowledge_ingestion_queue")
    .update({
      processing_stage: "approved",
      promoted_to_chunk_id: chunk.id,
      promoted_at: new Date().toISOString(),
      promotion_scope: "tenant",
      tenant_reviewed_by_user_id: ctx.user_id ?? null,
      tenant_reviewed_at: new Date().toISOString(),
    })
    .eq("id", body.queue_item_id);

  return Response.json({ chunk_id: chunk.id });
});

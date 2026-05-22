// §8.4 — POST /api/retrieve
//
// All retrieval is scoped to the tenant identified by the JWT (ctx.tenant_id).
// The body.tenant_id field MUST match ctx.tenant_id — a mismatch is surfaced
// as 403 to catch caller bugs early (defense-in-depth; JWT is authoritative).
export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { embed } from "@/lib/embeddings/openai";
import { RetrieveRequestSchema } from "@/lib/schemas/retrieve";

export const POST = withServiceAuth(async (req, ctx) => {
  const retrieval_id = randomUUID();

  let body: ReturnType<typeof RetrieveRequestSchema.parse>;
  try {
    const raw = await req.json();
    body = RetrieveRequestSchema.parse(raw);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Defense-in-depth: JWT tenant must match body tenant.
  if (body.tenant_id !== ctx.tenant_id) {
    return Response.json({ error: "tenant_id_mismatch_with_jwt" }, { status: 403 });
  }

  const start = Date.now();

  try {
    // Generate query embedding
    const queryEmbedding = await embed(body.query);

    // Vector similarity search via pgvector RPC
    const db = getRagDb();
    const { data: chunks, error } = await db.rpc("match_knowledge_chunks", {
      p_query_embedding: `[${queryEmbedding.join(",")}]`,
      p_tenant_id: ctx.tenant_id,
      p_top_k: body.top_k,
      p_include_closed_promo_contact_id: body.include_closed_promos_for_contact ?? null,
      p_category: body.filters?.category ?? null,
      p_cruise_line: body.filters?.cruise_line ?? null,
      p_ship: body.filters?.ship ?? null,
      p_destination: body.filters?.destination ?? null,
      p_agent_slug: body.filters?.agent_slug ?? null,
    });

    if (error) throw new Error(error.message);

    const latency_ms = Date.now() - start;

    // Write retrieval log (non-blocking; don't fail the request if this fails)
    void db.from("rag_retrieval_log").insert({
      id: retrieval_id,
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      conversation_id: body.conversation_id,
      persona_id: body.persona_id,
      query_text: body.query,
      filters_applied: body.filters,
      chunks_returned: (chunks as Array<{ id: string }>)?.map((c) => c.id) ?? [],
      top_k_requested: body.top_k,
      retrieval_latency_ms: latency_ms,
      outcome: "success",
    });

    const result = (chunks ?? []).map((c: Record<string, unknown>) => ({
      id: c.id,
      content: c.content,
      content_hash: c.content_hash,
      scope: c.scope,
      tenant_id: c.tenant_id,
      category: c.category,
      cruise_line_or_supplier: c.cruise_line_or_supplier,
      ship_or_property: c.ship_or_property,
      destination: c.destination,
      agent_scope: c.agent_scope,
      tags: c.tags,
      source_type: c.source_type,
      source_url: c.source_url,
      source_domain: c.source_domain,
      ingested_at: c.ingested_at,
      expires_at: c.expires_at,
      contains_pricing: c.contains_pricing,
      scoring: {
        match_score: c.match_score,
        authority: c.authority_score,
        authority_tier: c.authority_manual_override ?? c.authority_auto,
        recency: c.recency_score,
        composite_confidence: c.composite_confidence,
      },
      metadata: {
        ingested_at: c.ingested_at,
        expires_at: c.expires_at,
        is_promo: c.sell_by_at != null,
      },
    }));

    return Response.json({
      chunks: result,
      retrieval_id,
      retrieval_latency_ms: latency_ms,
    });
  } catch (err) {
    console.error("[retrieve] error:", err);
    return Response.json(
      { error: "retrieval_internal_error", retrieval_id },
      { status: 500 },
    );
  }
});

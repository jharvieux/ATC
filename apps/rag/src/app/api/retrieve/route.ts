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

    // allow-void-async: retrieval log is best-effort analytics, idempotent on
    // retrieval_id (PK); the retrieval path is latency-sensitive so we don't block on it.
    // The insert error is still observed + logged (D-091 Pattern 1) rather than
    // discarded; it's just not surfaced, since the log row is non-load-bearing.
    void (async () => {
      const { error: logErr } = await db.from("rag_retrieval_log").insert({
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
      if (logErr) console.warn(`[retrieve] rag_retrieval_log insert failed: ${logErr.message}`);
    })();

    // BP38 §33.6.4 — hydrate related_asset_ids per chunk (the RPC does not
    // return that column). One additional SELECT keyed by chunk IDs.
    const vectorRows = (chunks ?? []) as Array<Record<string, unknown>>;

    // #826 — structured exact-date itinerary match. Vector search can't reliably
    // surface an exact-date sailing among many near-identical chunks, so when the
    // caller passes ship+date we resolve the matching itineraries' REAL chunks and
    // boost them to the top. Best-effort: a lookup failure degrades to vector-only
    // (this is a retrieval enhancement, not an enforcement path — never break chat).
    let structuredRows: Array<Record<string, unknown>> = [];
    if (body.itinerary_lookup) {
      try {
        structuredRows = await fetchItineraryLookupChunks(db, ctx.tenant_id, body.itinerary_lookup);
      } catch (e) {
        console.warn(`[retrieve] itinerary_lookup failed (degrading to vector-only): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const structuredIds = new Set(structuredRows.map((c) => c.id as string));
    const chunkRows = [...structuredRows, ...vectorRows.filter((c) => !structuredIds.has(c.id as string))];
    const chunkIds = chunkRows.map((c) => c.id as string);
    const assetIdsByChunk = new Map<string, string[]>();
    if (chunkIds.length > 0) {
      const { data: assetLinks } = await db
        .from("knowledge_chunks")
        .select("id, related_asset_ids, scope")
        .in("id", chunkIds);
      for (const row of (assetLinks ?? []) as Array<{ id: string; related_asset_ids: string[] | null; scope: "global" | "tenant" }>) {
        assetIdsByChunk.set(row.id, row.related_asset_ids ?? []);
      }
    }

    // Collect union of all asset IDs across chunks and batch-fetch metadata.
    // Scope filter at retrieve time: a global chunk surfaces only global assets,
    // a tenant chunk only its own tenant's assets (matches ingest invariant —
    // defense-in-depth in case a row got upserted out of band).
    const allAssetIds = new Set<string>();
    for (const ids of assetIdsByChunk.values()) for (const id of ids) allAssetIds.add(id);

    interface AssetMetadata {
      asset_id: string;
      kind: string;
      entity_type: string;
      entity_id: string;
      image_url: string;
      source_page_url: string;
      attribution: string;
      caption: string | null;
      width_px: number | null;
      height_px: number | null;
    }
    const assets: AssetMetadata[] = [];
    const validAssetIds = new Set<string>();
    if (allAssetIds.size > 0) {
      // DB-layer tenant isolation (D-091 #395): the .or() is the first of two
      // layers — without it the JS `continue` below is the ONLY thing keeping
      // another tenant's asset metadata out of the response, one out-of-band
      // upsert away from a cross-tenant leak. ctx.tenant_id is a validated UUID
      // (RetrieveRequestSchema), safe to interpolate into the PostgREST filter.
      const { data: assetRows } = await db
        .from("rag_media_assets")
        .select("asset_id, kind, entity_type, entity_id, scope, tenant_id, image_url, source_page_url, attribution, caption, width_px, height_px")
        .in("asset_id", [...allAssetIds])
        .or(`scope.eq.global,tenant_id.eq.${ctx.tenant_id}`);
      for (const r of (assetRows ?? []) as Array<{ asset_id: string; kind: string; entity_type: string; entity_id: string; scope: "global" | "tenant"; tenant_id: string | null; image_url: string; source_page_url: string; attribution: string; caption: string | null; width_px: number | null; height_px: number | null }>) {
        // Second layer — drop a tenant-scope asset the caller shouldn't see.
        if (r.scope === "tenant" && r.tenant_id !== ctx.tenant_id) continue;
        validAssetIds.add(r.asset_id);
        assets.push({
          asset_id: r.asset_id,
          kind: r.kind,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          image_url: r.image_url,
          source_page_url: r.source_page_url,
          attribution: r.attribution,
          caption: r.caption,
          width_px: r.width_px,
          height_px: r.height_px,
        });
      }
    }

    // Log any dropped IDs once per request — caller may have stale links.
    const droppedAssetIds: string[] = [];
    for (const id of allAssetIds) if (!validAssetIds.has(id)) droppedAssetIds.push(id);
    if (droppedAssetIds.length > 0) {
      console.warn(`[retrieve] dropped ${droppedAssetIds.length} asset id(s) — missing or out-of-scope`, { retrieval_id, dropped_count: droppedAssetIds.length });
    }

    const result = chunkRows.map((c) => {
      const linked = assetIdsByChunk.get(c.id as string) ?? [];
      // Filter chunk's related_asset_ids to only those we resolved.
      const resolved = linked.filter((id) => validAssetIds.has(id));
      return {
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
        related_asset_ids: resolved,
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
      };
    });

    return Response.json({
      chunks: result,
      assets,
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

// #826 — resolve an exact ship+date lookup to the REAL knowledge chunks for the
// matching sailings (via itineraries.related_chunk_id), shaped like the
// match_knowledge_chunks RPC output with a top-rank synthetic score. Using real
// chunk ids keeps the §6.10 feedback loop intact. Two-layer tenant isolation:
// the .or() restricts to global OR this tenant's chunks (defense-in-depth — the
// itineraries rows are global, but never trust that alone).
export async function fetchItineraryLookupChunks(
  db: ReturnType<typeof getRagDb>,
  tenantId: string,
  lookup: { ship: string; sail_date_from: string; sail_date_to?: string | undefined },
): Promise<Array<Record<string, unknown>>> {
  const from = lookup.sail_date_from;
  const to = lookup.sail_date_to ?? lookup.sail_date_from;

  const { data: itins, error: itinErr } = await db
    .from("itineraries")
    .select("related_chunk_id")
    .ilike("ship", `%${lookup.ship}%`)
    .gte("departure_date", from)
    .lte("departure_date", to)
    .not("related_chunk_id", "is", null)
    .order("departure_date", { ascending: true })
    .limit(6);
  if (itinErr) throw new Error(`itineraries lookup failed: ${itinErr.message}`);

  const chunkIds = [
    ...new Set(
      (itins ?? [])
        .map((r) => (r as { related_chunk_id: string | null }).related_chunk_id)
        .filter((id): id is string => !!id),
    ),
  ];
  if (chunkIds.length === 0) return [];

  const { data: rows, error: chunkErr } = await db
    .from("knowledge_chunks")
    .select(
      "id, content, content_hash, scope, tenant_id, category, cruise_line_or_supplier, ship_or_property, destination, agent_scope, tags, source_type, source_url, source_domain, ingested_at, expires_at, contains_pricing, sell_by_at, authority_auto, authority_manual_override",
    )
    .in("id", chunkIds)
    .eq("status", "approved")
    .or(`scope.eq.global,tenant_id.eq.${tenantId}`);
  if (chunkErr) throw new Error(`itinerary chunk fetch failed: ${chunkErr.message}`);

  return (rows ?? []).map((c) => {
    const row = c as Record<string, unknown>;
    return {
      ...row,
      // Exact structured match → rank ahead of vector hits.
      match_score: 1,
      authority_score: (row.authority_manual_override ?? row.authority_auto) ?? null,
      recency_score: 1,
      composite_confidence: 1,
    };
  });
}

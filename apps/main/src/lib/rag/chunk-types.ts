// §21 — Retrieved chunk shape as the chat-side consumer sees it.
// Mirrors the projection in apps/rag/src/app/api/retrieve/route.ts.

export interface RetrievedChunkScoring {
  match_score: number | null;
  authority: number | null;
  authority_tier: string | null;
  recency: number | null;
  composite_confidence: number | null;
}

export interface RetrievedChunkMetadata {
  ingested_at: string | null;
  expires_at: string | null;
  is_promo: boolean;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  content_hash: string | null;
  scope: "tenant" | "global" | string;
  tenant_id: string | null;
  category: string | null;
  cruise_line_or_supplier: string | null;
  ship_or_property: string | null;
  destination: string | null;
  agent_scope: string[] | null;
  tags: string[] | null;
  source_type: string | null;
  source_url: string | null;
  source_domain: string | null;
  ingested_at: string | null;
  expires_at: string | null;
  contains_pricing: boolean | null;
  scoring: RetrievedChunkScoring;
  metadata: RetrievedChunkMetadata;
  // Optional extras the chat-side may set after retrieval:
  // - chunk-level embedding (for client-side dedup if RAG doesn't supply pairwise distances)
  embedding?: number[];
  // - promo lifecycle from the §6.9 closed-promo override path
  promo_status?: "open" | "closed_to_new" | string | null;
  // - §21.8 authoritative_override (chunks tagged WIN)
  authority_kind?: "authoritative_override" | "standard" | string | null;
  // BP38 §33.6.4 — UUIDs of rag_media_assets rows this chunk references.
  related_asset_ids?: string[];
}

// BP38/39 §33.6.4 / §33.7 — asset metadata returned by /api/retrieve.
// Curated subset of rag_media_assets columns safe to expose to consumers.
export interface RetrievedAsset {
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

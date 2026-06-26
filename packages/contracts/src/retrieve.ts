// POST /api/retrieve — main → rag (vector search + scoring).
// Spec: §8.4 (retrieval), §6 (composite scoring), §33.6.4 (related assets).
//
// Until BP38 this contract lived in two places:
//   - apps/rag/src/lib/schemas/retrieve.ts (request only)
//   - apps/main/src/lib/rag/chunk-types.ts (response, hand-mirrored)
// Both now re-export from this module so a field added here propagates to
// both sides at typecheck time.

import { z } from "zod";

const UUID = z.string().uuid();

// ── Request ─────────────────────────────────────────────────────────────

export const RetrieveRequestSchema = z.object({
  query: z.string().min(1),
  tenant_id: UUID,
  // Anon chat turns have no authenticated user — allow null.
  user_id: UUID.nullable().optional().default(null),
  // #904 draft-reply turns have no conversation row — allow null. The rag
  // side logs it into rag_retrieval_log.conversation_id, which is nullable
  // (apps/rag/supabase/migrations/0003_ingestion_queue_and_retrieval_log.sql:65).
  conversation_id: UUID.nullable().optional().default(null),
  // Personas are identified by slug at the call site (e.g. "marcus-cole").
  // The RAG route logs persona_id to rag_retrieval_log.persona_id (UUID column)
  // but guards slugs with a UUID regex and inserts null instead — so slugs and
  // UUIDs both pass this schema but only UUIDs are preserved in the log.
  persona_id: z.string().min(1),
  filters: z
    .object({
      category: z.string().optional(),
      cruise_line: z.string().optional(),
      ship: z.string().optional(),
      destination: z.string().optional(),
      agent_slug: z.string().optional(),
    })
    .optional()
    .default({}),
  top_k: z.number().int().min(1).max(20).default(10),
  include_closed_promos_for_contact: UUID.nullable().optional().default(null),
  // #826 — when the message names a ship + a specific sail date, the caller
  // passes this so the rag service runs a STRUCTURED itineraries lookup. Vector
  // search can't reliably surface an exact-date sailing among many near-identical
  // chunks; the matched sailings' REAL chunks are returned boosted to the top.
  itinerary_lookup: z
    .object({
      ship: z.string().min(1),
      sail_date_from: z.string(), // ISO YYYY-MM-DD
      sail_date_to: z.string().optional(),
    })
    .nullable()
    .optional()
    .default(null),
  // When the message names a specific ship, always include that ship's
  // deck_intel and ship_intel chunks (deck plans, vessel specs). Vector search
  // can miss these when the question is about a venue or amenity rather than
  // an itinerary keyword.
  ship_lookup: z
    .object({ ship: z.string().min(1) })
    .nullable()
    .optional()
    .default(null),
  // When the message asks what ships depart FROM a specific port on a date,
  // run a structured departure-port lookup against the itineraries table.
  port_lookup: z
    .object({
      departure_port: z.string().min(1),
      date_from: z.string(), // ISO YYYY-MM-DD
      date_to: z.string().optional(),
    })
    .nullable()
    .optional()
    .default(null),
  // When the message names a REGION/AREA (e.g. "Australia", "Caribbean") plus a
  // date window — but no single ship or departure port — run a structured
  // region lookup against the itineraries table. Vector search can't enumerate
  // sailings across a region, and the itineraries.region column is unset on a
  // large share of rows, so the caller passes BOTH a set of region terms AND a
  // set of port tokens (a country expands to its major cruise ports); the rag
  // RPC matches region OR departure_port OR any port_of_call against either set.
  // sail_date_from is required so the window is always bounded.
  region_lookup: z
    .object({
      region_terms: z.array(z.string().min(1)).default([]),
      port_terms: z.array(z.string().min(1)).default([]),
      // Optional ORIGIN constraint: when the customer says "from the US to
      // Australia", the destination match (region/port terms) is AND'd with a
      // requirement that the DEPARTURE port is one of these, so round-trip
      // sailings that merely visit the destination are excluded. Empty = no
      // origin constraint (destination match only).
      origin_port_terms: z.array(z.string().min(1)).default([]),
      date_from: z.string(), // ISO YYYY-MM-DD
      date_to: z.string().optional(),
    })
    .nullable()
    .optional()
    .default(null),
});
export type RetrieveRequest = z.infer<typeof RetrieveRequestSchema>;

// ── Response ────────────────────────────────────────────────────────────

// Scoring sub-object. All nullable because the RPC may return nulls if a
// downstream factor is missing (e.g. no feedback signal yet).
export const RetrievedChunkScoringSchema = z.object({
  match_score: z.number().nullable(),
  authority: z.number().nullable(),
  authority_tier: z.union([z.string(), z.number()]).nullable(),
  recency: z.number().nullable(),
  composite_confidence: z.number().nullable(),
});
export type RetrievedChunkScoring = z.infer<typeof RetrievedChunkScoringSchema>;

export const RetrievedChunkMetadataSchema = z.object({
  ingested_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  is_promo: z.boolean(),
});
export type RetrievedChunkMetadata = z.infer<typeof RetrievedChunkMetadataSchema>;

export const RetrievedChunkSchema = z.object({
  id: UUID,
  content: z.string(),
  content_hash: z.string().nullable(),
  // Server emits literal "tenant" | "global"; accept any string for forward
  // compatibility and let downstream code narrow as needed.
  scope: z.string(),
  tenant_id: z.string().nullable(),
  category: z.string().nullable(),
  cruise_line_or_supplier: z.string().nullable(),
  ship_or_property: z.string().nullable(),
  destination: z.string().nullable(),
  agent_scope: z.array(z.string()).nullable(),
  tags: z.array(z.string()).nullable(),
  source_type: z.string().nullable(),
  source_url: z.string().nullable(),
  source_domain: z.string().nullable(),
  ingested_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  contains_pricing: z.boolean().nullable(),
  scoring: RetrievedChunkScoringSchema,
  metadata: RetrievedChunkMetadataSchema,
  // Chat-side decorations (set after retrieval, not by the rag service):
  embedding: z.array(z.number()).optional(),
  promo_status: z.string().nullable().optional(),
  authority_kind: z.string().nullable().optional(),
  // §33.6.4 — asset linkage.
  related_asset_ids: z.array(UUID).optional(),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

export const RetrievedAssetSchema = z.object({
  asset_id: UUID,
  kind: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  image_url: z.string(),
  source_page_url: z.string(),
  attribution: z.string(),
  caption: z.string().nullable(),
  width_px: z.number().nullable(),
  height_px: z.number().nullable(),
});
export type RetrievedAsset = z.infer<typeof RetrievedAssetSchema>;

export const RetrieveResponseSchema = z.object({
  chunks: z.array(RetrievedChunkSchema),
  assets: z.array(RetrievedAssetSchema),
  retrieval_id: UUID.nullable(),
  retrieval_latency_ms: z.number().nullable(),
});
export type RetrieveResponse = z.infer<typeof RetrieveResponseSchema>;

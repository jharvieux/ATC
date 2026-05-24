-- BP33 §33.6.2 — knowledge_chunks.related_asset_ids column.
--
-- Links a chunk to zero-or-more rag_media_assets rows. The retrieve API
-- (BP38) joins on these IDs and returns asset metadata alongside chunks.
--
-- NOT NULL DEFAULT '{}' so existing rows get the empty-array sentinel
-- without a backfill. No FK to rag_media_assets — Postgres doesn't
-- support FKs on array elements, and the retrieval path tolerates a
-- broken-link missing-asset case gracefully (asset simply isn't rendered).

ALTER TABLE public.knowledge_chunks
  ADD COLUMN related_asset_ids UUID[] NOT NULL DEFAULT '{}'::UUID[];

-- GIN index for "find chunks referencing this asset" queries (BP38
-- retrieval will hit this when rendering asset-bearing chat answers).
CREATE INDEX idx_knowledge_chunks_related_assets
  ON public.knowledge_chunks USING GIN (related_asset_ids);

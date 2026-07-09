-- Migration: retrieval_trgm_and_hnsw_indexes
-- Version:   20260709105128
-- Generated: 2026-07-09T10:51:28Z by scripts/new-migration.sh
-- Branch:    feature/sweep-rag-1273
--
-- #1589 — chat-critical-path retrieval index coverage.
--
-- 1. Leading-wildcard ILIKE lookups (retrieve/route.ts) had no usable index and
--    sequential-scanned growing tables on every ship-/port-mentioning message:
--      • itineraries.ship            (fetchItineraryLookupChunks)
--      • itineraries.departure_port  (fetchPortLookupChunks)
--      • knowledge_chunks.ship_or_property (fetchShipLookupChunks)
--    pg_trgm GIN indexes make `col ILIKE '%term%'` index-usable (trigram match),
--    turning those seq scans into index scans.
--
-- 2. The vector similarity index was built ivfflat in 0002 on a zero-row table.
--    ivfflat centroids train on data present at build time, so a corpus that
--    grew after an empty-table build has degraded recall and is never retrained
--    without a manual REINDEX. HNSW has no training step (graph is built/updated
--    incrementally), so recall doesn't rot as the corpus grows. Build the HNSW
--    index first, then drop the old ivfflat, so there is never a window with no
--    vector index. Both are plain (non-CONCURRENTLY) per the no-CONCURRENTLY
--    multi-statement rule in docs/runbooks/migrations.md — the operator applies
--    this via psql (RAG MCP is read-only) and should time the HNSW build for a
--    low-traffic window, as it holds a lock while it builds.
--
-- Index-only + extension migration: no policy/grant change, so no rls/grants
-- snapshot regen (extension-owned objects are dependency-excluded from the
-- snapshots, same as the existing `vector` extension).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_itineraries_ship_trgm
  ON public.itineraries USING gin (ship gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_itineraries_departure_port_trgm
  ON public.itineraries USING gin (departure_port gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_ship_or_property_trgm
  ON public.knowledge_chunks USING gin (ship_or_property gin_trgm_ops);

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
  ON public.knowledge_chunks USING hnsw (embedding vector_cosine_ops);

DROP INDEX IF EXISTS public.knowledge_chunks_embedding_idx;

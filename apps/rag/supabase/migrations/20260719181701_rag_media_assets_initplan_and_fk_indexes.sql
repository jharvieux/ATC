-- Migration: rag_media_assets_initplan_and_fk_indexes
-- Version:   20260719181701
-- Generated: 2026-07-19T18:17:01Z by scripts/new-migration.sh
-- Branch:    feature/sweep-rag-db-2005
-- Worktree:  agent-a3a10eb007fa7bbec
--
-- #2008 — RAG Supabase advisor hardening (two of the three flagged items).
--
-- 1. RLS init-plan (auth_rls_initplan WARN): the rag_media_assets_select
--    policy calls current_setting('request.jwt.claim.tenant_id') per row.
--    Wrapping it in a scalar subselect `(select current_setting(...))` lets
--    the planner evaluate it once per query instead of once per row. See
--    https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--    The predicate is otherwise byte-for-byte unchanged (scope='global' OR
--    tenant match), so tenant isolation semantics are identical.
--
-- 2. Unindexed foreign keys (unindexed_foreign_keys INFO): four FKs onto
--    knowledge_chunks(id) lacked a covering index, so cascade/ON DELETE
--    lookups and joins seq-scan the child table. Add a plain btree index on
--    each referencing column. `_idx` suffix per docs/runbooks/migrations.md.
--    Plain (non-CONCURRENTLY) CREATE INDEX — this is a multi-statement file
--    and CONCURRENTLY errors SQLSTATE 25001 in a single pipeline; the tables
--    are small so the brief lock is negligible.
--
-- Scoped OUT of this migration (see remainder issue): the extensions-in-public
-- finding (vector + pg_trgm installed in `public`). Relocating them via
-- `ALTER EXTENSION ... SET SCHEMA extensions` is unsafe here — the retrieval
-- SECURITY DEFINER functions run with `SET search_path = 'public'` and use the
-- unqualified pgvector `<=>` operator (e.g. 0028_match_knowledge_chunks_two_phase_retrieval.sql),
-- and pg_trgm GIN opclasses back live indexes. Moving the extensions out of
-- `public` would break operator/opclass resolution unless every such function
-- is rewritten to add `extensions` to its search_path — a retrieval-critical
-- change well beyond advisor hardening. Deferred rather than forced.
--
-- Policy change → RLS snapshot regenerated in the same PR (db/rls-snapshot-rag.sql).

DROP POLICY IF EXISTS rag_media_assets_select ON public.rag_media_assets;
CREATE POLICY rag_media_assets_select ON public.rag_media_assets
  FOR SELECT USING (
    scope = 'global'
    OR tenant_id::text = (SELECT current_setting('request.jwt.claim.tenant_id', true))
  );

CREATE INDEX IF NOT EXISTS itineraries_related_chunk_id_idx
  ON public.itineraries (related_chunk_id);

CREATE INDEX IF NOT EXISTS knowledge_chunks_superseded_by_chunk_id_idx
  ON public.knowledge_chunks (superseded_by_chunk_id);

CREATE INDEX IF NOT EXISTS knowledge_ingestion_queue_promoted_to_chunk_id_idx
  ON public.knowledge_ingestion_queue (promoted_to_chunk_id);

CREATE INDEX IF NOT EXISTS pending_embedding_chunk_id_idx
  ON public.pending_embedding (chunk_id);

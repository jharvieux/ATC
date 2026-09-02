-- Migration: relocate_vector_and_trgm_extensions
-- Version:   20260902082656
-- Generated: 2026-09-02T08:26:56Z by scripts/new-migration.sh
-- Branch:    feature/sweep-rag-extensions-2022-final
-- Worktree:  atc-sweep-rag-extensions-2022-final
--
-- #2022 — Supabase's extension_in_public advisor flags vector and pg_trgm.
-- Both installed versions are relocatable on the managed PG17 build. Existing
-- vector/trigram indexes bind extension objects by OID, so moving the extension
-- schemas preserves them. match_knowledge_chunks resolves the unqualified <=>
-- operator at execution time, so its pinned path must include extensions before
-- vector moves. match_region_itinerary_chunks uses built-in ILIKE; its trigram
-- indexes stay OID-bound and its narrower public-only path remains correct.
--
-- Rollback requires the reverse extension moves plus restoring the retrieval
-- function path. Keep that as an operator-run maintenance action rather than
-- an automatic down migration so catalog state and retrieval are reverified.

CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;

ALTER FUNCTION public.match_knowledge_chunks(
  public.vector,
  UUID,
  INTEGER,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TEXT
) SET search_path = public, extensions;

ALTER EXTENSION vector SET SCHEMA extensions;
ALTER EXTENSION pg_trgm SET SCHEMA extensions;

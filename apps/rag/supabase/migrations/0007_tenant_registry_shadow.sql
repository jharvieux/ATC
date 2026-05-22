-- §8.3: tenant_registry_shadow — shadow table for RAG-side tenant validation
--
-- Replaces the earlier tenant_registry table from §6.2 (migration 0001).
-- That table had a different shape (no display_name, no source_revision,
-- 'synced_at' instead of 'last_webhook_sync_at') and was always empty because
-- no sync mechanism existed yet. It is dropped here and recreated with the
-- final BP08 shape. This deviation is logged in MEMORY.md (D-043).
--
-- No RLS — RAG service uses service-role exclusively (see apps/rag/db/rls-snapshot.sql).
-- This is a documented, intentional exception per the BP06 decision.

-- Drop old empty table. CASCADE removes the FK constraint on knowledge_chunks.tenant_id
-- that was declared in migration 0002. Tenant isolation is enforced in application code
-- (scope filter per §6.9), not by FK, so the unconstrained column is correct.
DROP TABLE IF EXISTS public.tenant_registry CASCADE;

CREATE TABLE public.tenant_registry_shadow (
  tenant_id               UUID        PRIMARY KEY,
  status                  TEXT        NOT NULL CHECK (status IN ('active','suspended','terminated','pending_review','onboarding')),
  tenant_type             TEXT        NOT NULL,
  display_name            TEXT        NOT NULL,
  last_webhook_sync_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reconcile_sync_at  TIMESTAMPTZ,
  source_revision         INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX tenant_registry_shadow_status_idx
  ON public.tenant_registry_shadow (status);

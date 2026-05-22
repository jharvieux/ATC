-- §15.14.5 — Post-termination columns on knowledge_chunks.
--
-- SPEC CORRECTION: The BP17 spec says terminated_origin_tenant_id references
-- the main-app tenants table. That's a cross-DB reference — impossible in
-- Postgres. This FK targets the RAG-side tenant_registry_shadow table instead.
-- See MEMORY D-050 for the correction.

ALTER TABLE public.knowledge_chunks
  ADD COLUMN IF NOT EXISTS terminated_origin_tenant_id UUID
    REFERENCES public.tenant_registry_shadow(tenant_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS post_termination_review_status TEXT
    NOT NULL DEFAULT 'not_applicable'
    CHECK (post_termination_review_status IN (
      'not_applicable','pending','reviewed_retained',
      'reviewed_demoted','reviewed_hard_deleted'
    )),
  ADD COLUMN IF NOT EXISTS ingest_user_id UUID; -- user who submitted for ingestion (§17.9 CCPA)

CREATE INDEX knowledge_chunks_post_term_idx
  ON public.knowledge_chunks(terminated_origin_tenant_id)
  WHERE terminated_origin_tenant_id IS NOT NULL;

CREATE INDEX knowledge_chunks_post_term_review_idx
  ON public.knowledge_chunks(post_termination_review_status)
  WHERE post_termination_review_status = 'pending';

-- §22 — RAG ingestion pipeline (main-app side).
--
-- The tenant review queue lives on the main-app side because it is a
-- user-facing workflow with tenant-specific roles and edit history. The RAG
-- service still owns the canonical chunk corpus; main-app forwards approved
-- items to the RAG service's /ingest + /approve/tenant endpoints.
--
-- Tables created:
--   1. public.rag_submissions — per-submission pipeline tracking with
--      extraction → pii_redaction → normalization → review status columns.
--   2. public.rag_global_promotions — record of platform-admin promotions
--      of tenant chunks to global scope (under the §15.14.3 chunk-license-
--      survival contract). Tracks demotions in-place.
--
-- tenants additions (§22.4a) — PII quarantine alert aggregation state.

-- ── rag_submissions ─────────────────────────────────────────────────────────

CREATE TABLE public.rag_submissions (
  id                                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                         UUID         NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  submitted_by_user_id              UUID         NOT NULL REFERENCES public.users(id),

  -- Source metadata
  submission_method                 TEXT         NOT NULL
    CHECK (submission_method IN (
      'web_ui','browser_extension','ios_shortcut','file_upload','manual_entry','batch_api'
    )),
  source_url                        TEXT,
  source_title                      TEXT,

  -- Original content (text path vs file path)
  original_content                  TEXT,
  original_file_path                TEXT,
  original_file_mime_type           TEXT,

  -- Stage 1: extraction
  extraction_status                 TEXT         NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending','extracting','extracted','failed')),
  extracted_content                 TEXT,
  extraction_error                  TEXT,

  -- Stage 2: PII redaction (regex + Haiku)
  pii_redaction_status              TEXT         NOT NULL DEFAULT 'pending'
    CHECK (pii_redaction_status IN ('pending','clean','redacted','quarantined')),
  redacted_content                  TEXT,
  quarantine_categories             TEXT[],

  -- Stage 3: AI normalization
  normalization_status              TEXT         NOT NULL DEFAULT 'pending'
    CHECK (normalization_status IN ('pending','normalized','failed')),
  normalization_result              JSONB,

  -- Stage 4: review queue
  review_status                     TEXT         NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','ready_for_review','approved','rejected','superseded')),
  auto_flagged_for_global           BOOLEAN      NOT NULL DEFAULT FALSE,
  -- §22.7 Tab 2 — tenant clicked "suggest for global" on this submission.
  tenant_suggested_for_global       BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Duplicate detection — §22.12
  content_hash                      TEXT,
  supersedes_chunk_id               UUID,
  -- ID of the resulting knowledge_chunks row on the RAG side once approved.
  chunk_id_created                  UUID,

  -- Review audit
  tenant_review_decision_by_user_id UUID         REFERENCES public.users(id),
  tenant_review_decision_at         TIMESTAMPTZ,
  tenant_review_rejection_reason    TEXT,

  created_at                        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Tenant review queue: items ready for tenant approval
CREATE INDEX rag_submissions_review_queue_idx
  ON public.rag_submissions (tenant_id, review_status)
  WHERE review_status = 'ready_for_review';

-- Duplicate detection lookup
CREATE INDEX rag_submissions_content_hash_idx
  ON public.rag_submissions (content_hash, tenant_id)
  WHERE content_hash IS NOT NULL;

-- Auto-flagged-for-global review queue
CREATE INDEX rag_submissions_auto_flagged_idx
  ON public.rag_submissions (auto_flagged_for_global, review_status)
  WHERE auto_flagged_for_global = TRUE AND review_status = 'approved';

-- Tenant-suggested-for-global queue (Tab 2)
CREATE INDEX rag_submissions_tenant_suggested_idx
  ON public.rag_submissions (tenant_suggested_for_global, review_status)
  WHERE tenant_suggested_for_global = TRUE AND review_status = 'approved';

-- ── rag_global_promotions ───────────────────────────────────────────────────

CREATE TABLE public.rag_global_promotions (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id            UUID         NOT NULL REFERENCES public.rag_submissions(id),
  -- The tenant-scoped chunk ID (RAG side) that was promoted.
  tenant_chunk_id          UUID         NOT NULL,
  -- The new global-scope chunk ID (RAG side) created by /approve/global.
  global_chunk_id          UUID         NOT NULL,
  promoted_by_user_id      UUID         NOT NULL REFERENCES public.users(id),
  promotion_source         TEXT         NOT NULL
    CHECK (promotion_source IN ('auto_flagged','tenant_suggested','admin_browse','admin_one_off')),
  notes                    TEXT,
  -- audit_log FK deferred until §26 lands audit_log; bare UUID for now.
  audit_log_id             UUID,
  demoted_at               TIMESTAMPTZ,
  demoted_by_user_id       UUID         REFERENCES public.users(id),
  demote_mode              TEXT         CHECK (demote_mode IN ('to_tenant_scope','hard_delete')),
  demote_audit_log_id      UUID,
  promoted_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Active (un-demoted) promotions lookup
CREATE INDEX rag_global_promotions_active_idx
  ON public.rag_global_promotions (tenant_chunk_id)
  WHERE demoted_at IS NULL;

-- ── tenants — PII quarantine alert aggregation (§22.4a) ─────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS pii_quarantine_alert_window_start    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pii_quarantine_alert_count_in_window INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pii_quarantine_recurring_days        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pii_quarantine_last_event_at         TIMESTAMPTZ;

-- ── RLS — rag_submissions ───────────────────────────────────────────────────

ALTER TABLE public.rag_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_submissions_select_policy ON public.rag_submissions
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY rag_submissions_insert_policy ON public.rag_submissions
  FOR INSERT
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY rag_submissions_update_policy ON public.rag_submissions
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY rag_submissions_delete_policy ON public.rag_submissions
  FOR DELETE
  USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.rag_submissions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rag_submissions TO service_role;

-- ── RLS — rag_global_promotions ─────────────────────────────────────────────
--
-- Platform-admin-only via service_role (withPlatformAdminAudit).
-- Authenticated tenant users may SELECT rows where the submission belongs to
-- their tenant — useful for the tenant-side "your chunk was promoted to global"
-- notification surface.

ALTER TABLE public.rag_global_promotions ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_global_promotions_select_policy ON public.rag_global_promotions
  FOR SELECT
  USING (
    submission_id IN (
      SELECT id FROM public.rag_submissions
      WHERE auth_user_in_tenant(tenant_id)
    )
  );

CREATE POLICY rag_global_promotions_insert_policy ON public.rag_global_promotions
  FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY rag_global_promotions_update_policy ON public.rag_global_promotions
  FOR UPDATE
  USING (FALSE)
  WITH CHECK (FALSE);

CREATE POLICY rag_global_promotions_delete_policy ON public.rag_global_promotions
  FOR DELETE
  USING (FALSE);

GRANT SELECT ON public.rag_global_promotions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rag_global_promotions TO service_role;

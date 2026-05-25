-- BP34 §34.6 — In-flight + pending-review state for the import pipeline.
--
-- contact_imports (Phase A) is the final audit trail written AFTER an
-- import is accepted. The pipeline itself needs a working table to track
-- in-progress items + items awaiting agent review (§34.6 review queue).
--
-- Status transitions:
--   pending_virus_scan
--     ├── virus_detected  (terminal; quarantined 30d per §34.3.1)
--     └── pending_classification
--           ├── parse_failed  (retained 7d per §34.4)
--           └── pending_extraction
--                 ├── parse_failed
--                 └── pending_validation
--                       ├── pending_review  (waiting for agent action)
--                       │     ├── accepted
--                       │     └── rejected
--                       └── auto_accepted   (above threshold + no flags)
--
-- `purgable_at` is computed at status transition by the application — the
-- purge-parsed-documents cron simply does WHERE purgable_at <= NOW().

CREATE TABLE IF NOT EXISTS public.import_queue (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID         NOT NULL REFERENCES public.tenants(id),

  -- Source path + reference (gmail message_id, upload_id, or form_submission_id).
  import_path                 TEXT         NOT NULL CHECK (import_path IN ('email','document','manual')),
  source_ref                  TEXT         NOT NULL,
  submitted_by_user_id        UUID         REFERENCES public.users(id),

  -- Pipeline state.
  status                      TEXT         NOT NULL DEFAULT 'pending_virus_scan' CHECK (status IN (
    'pending_virus_scan',
    'virus_detected',
    'pending_classification',
    'pending_extraction',
    'pending_validation',
    'pending_review',
    'auto_accepted',
    'accepted',
    'rejected',
    'parse_failed'
  )),

  -- Classification output (§34.3.2).
  document_type               TEXT         CHECK (document_type IS NULL OR document_type IN (
    'lead_notification',
    'booking_confirmation',
    'commission_statement',
    'intake_form',
    'unknown'
  )),
  classification_confidence   NUMERIC(4,3) CHECK (classification_confidence IS NULL OR (classification_confidence >= 0 AND classification_confidence <= 1)),

  -- Extraction output (§34.3.3). raw_extracted_fields is verbatim parser
  -- output; per_field_confidence is keyed by field name with the same shape.
  raw_extracted_fields        JSONB,
  per_field_confidence        JSONB,
  extraction_overall_confidence NUMERIC(4,3) CHECK (extraction_overall_confidence IS NULL OR (extraction_overall_confidence >= 0 AND extraction_overall_confidence <= 1)),

  -- Validation output (§34.3.4) — array of {flag, reason} objects.
  validation_flags            JSONB         DEFAULT '[]'::JSONB,

  -- Document upload bookkeeping.
  uploaded_file_path          TEXT,
  uploaded_file_mime_type     TEXT,
  uploaded_file_size_bytes    BIGINT,
  parse_failure_reason        TEXT,

  -- Disposition (set when status transitions to accepted/rejected).
  accepted_at                 TIMESTAMPTZ,
  accepted_by_user_id         UUID         REFERENCES public.users(id),
  rejected_at                 TIMESTAMPTZ,
  rejected_by_user_id         UUID         REFERENCES public.users(id),
  rejected_reason             TEXT,

  -- Records produced by acceptance — FK so the queue row references the
  -- contact / booking / commission it generated. NULL for items still in
  -- flight, rejected, or virus-detected.
  promoted_contact_id         UUID         REFERENCES public.contacts(id),
  promoted_booking_id         UUID         REFERENCES public.bookings(id),

  -- §34.4 retention: when the purge-parsed-documents cron should remove
  -- this row + its uploaded_file_path blob. Set on each status transition
  -- per the retention matrix.
  purgable_at                 TIMESTAMPTZ,

  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS import_queue_tenant_status_idx
  ON public.import_queue (tenant_id, status);

CREATE INDEX IF NOT EXISTS import_queue_pending_review_idx
  ON public.import_queue (tenant_id, created_at DESC)
  WHERE status = 'pending_review';

CREATE INDEX IF NOT EXISTS import_queue_purgable_idx
  ON public.import_queue (purgable_at)
  WHERE purgable_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS import_queue_source_ref_idx
  ON public.import_queue (tenant_id, source_ref);

-- BEFORE UPDATE trigger to bump updated_at (saves every caller from doing it).
CREATE OR REPLACE FUNCTION public.set_import_queue_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS import_queue_updated_at_trg ON public.import_queue;
CREATE TRIGGER import_queue_updated_at_trg
  BEFORE UPDATE ON public.import_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.set_import_queue_updated_at();

-- ── RLS — standard §5.1 pattern ─────────────────────────────────────────
ALTER TABLE public.import_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY import_queue_select ON public.import_queue
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY import_queue_insert ON public.import_queue
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY import_queue_update ON public.import_queue
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY import_queue_delete ON public.import_queue
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_queue TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_queue TO service_role;

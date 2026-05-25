-- BP34 §34.8 — Schema additions for the inbound-import surface.
--
-- Three concerns:
--   1. bookings: 5 new columns to distinguish imported bookings from
--      platform-originated ones and carry the host's reference number
--      (used by §14.8 statement reconciliation matching).
--   2. commissions: 1 column for commission-rate provenance tracking
--      (per §34.7.3) + 3 columns for clawback handling (per §34.8.2 —
--      written by §14.9, read by §36 reporting).
--   3. New contact_imports table to keep an audit trail of each
--      import-driven contact write (per §34.5.1), even after the source
--      document has been purged per §34.4.
--
-- All additions are non-breaking: existing rows get the column defaults,
-- existing read paths ignore the new columns until call sites are updated.

-- ── 1. bookings columns ────────────────────────────────────────────────────
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'platform'
    CHECK (origin IN ('platform','imported')),
  ADD COLUMN IF NOT EXISTS imported_from TEXT
    CHECK (imported_from IS NULL OR imported_from IN ('email','document','manual')),
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS imported_by_user_id UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS provider_booking_ref TEXT;

-- Belt-and-suspenders: imported_* columns are NULL iff origin='platform'.
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_origin_imported_consistency CHECK (
    (origin = 'platform' AND imported_from IS NULL AND imported_at IS NULL)
    OR
    (origin = 'imported' AND imported_from IS NOT NULL AND imported_at IS NOT NULL)
  );

-- Partial index for §14.8 statement matching — exact-ref lookups skip
-- platform-origin bookings entirely.
CREATE INDEX IF NOT EXISTS bookings_provider_ref_idx
  ON public.bookings (tenant_id, provider_booking_ref)
  WHERE provider_booking_ref IS NOT NULL;

-- ── 2. commissions columns ────────────────────────────────────────────────
ALTER TABLE public.commissions
  ADD COLUMN IF NOT EXISTS commission_rate_source TEXT
    CHECK (commission_rate_source IS NULL OR commission_rate_source IN (
      'host_adapter',
      'doc_parsed',
      'agent_set',
      'agent_corrected'
    )),
  ADD COLUMN IF NOT EXISTS clawback_amount_cents BIGINT NOT NULL DEFAULT 0
    CHECK (clawback_amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS clawback_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clawback_reason TEXT;

-- clawback_at MUST be set iff clawback_amount_cents > 0.
ALTER TABLE public.commissions
  ADD CONSTRAINT commissions_clawback_consistency CHECK (
    (clawback_amount_cents = 0 AND clawback_at IS NULL)
    OR
    (clawback_amount_cents > 0 AND clawback_at IS NOT NULL)
  );

-- ── 3. contact_imports table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_imports (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES public.tenants(id),
  contact_id            UUID         NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  import_path           TEXT         NOT NULL CHECK (import_path IN ('email','document','manual')),
  source_ref            TEXT         NOT NULL,
  document_type         TEXT         NOT NULL CHECK (document_type IN (
                                       'lead_notification',
                                       'booking_confirmation',
                                       'commission_statement',
                                       'intake_form',
                                       'unknown'
                                     )),
  confidence            NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  imported_by_user_id   UUID         REFERENCES public.users(id),
  imported_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Verbatim parser output. Retained even after source document purge so a
  -- later dispute ("the parser saw the wrong DOB") can be reconstructed.
  -- §25 deletion scope includes this when the parent contact is deleted
  -- (the ON DELETE CASCADE above handles it).
  raw_extracted_fields  JSONB,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contact_imports_tenant_contact_idx
  ON public.contact_imports (tenant_id, contact_id);

CREATE INDEX IF NOT EXISTS contact_imports_source_ref_idx
  ON public.contact_imports (tenant_id, source_ref);

-- ── RLS — §5.1 standard pattern ──────────────────────────────────────────
ALTER TABLE public.contact_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_imports_select ON public.contact_imports
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY contact_imports_insert ON public.contact_imports
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY contact_imports_update ON public.contact_imports
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY contact_imports_delete ON public.contact_imports
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_imports TO service_role;

-- ── 4. platform_settings — auto-accept threshold default ─────────────────
-- §34.3.5 specifies 0.80 default, tenant-configurable in [0.60, 1.00].
-- Tenant overrides live on a tenant_settings column (added later); this is
-- just the platform-wide default.
INSERT INTO public.platform_settings (key, value, description) VALUES
  (
    'bp34_import_auto_accept_threshold_default',
    '0.80'::JSONB,
    'BP34 §34.3.5 — default overall extraction confidence threshold for auto-accept. Tenants can override in CRM settings within [0.60, 1.00].'
  )
ON CONFLICT (key) DO NOTHING;

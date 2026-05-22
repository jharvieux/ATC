-- §14.0 / §14.3 / §14.12 — Money columns and new tables for commission lifecycle.
--
-- Existing schema (from 20260521160000_bookings_commissions.sql) already has:
--   commissions.commissionable_fare_cents BIGINT — correct per §14.0.1 (no rename needed)
--   commissions.commission_rate NUMERIC(5,4) — correct (no rename from _percent needed)
--   commissions.platform_split_rate NUMERIC(5,4) — already present
--   commissions.gross/net/platform/subhost cents — already present
--   commissions.host_booking_fee_cents — already present
--   commissions.currency — already present
--   commissions.status (enum commission_status) — used as state column
--   payout_records.attempt_generation INTEGER DEFAULT 1 — already present
--
-- MEMORY note: The spec (§14.0.1 callout + §14.2) describes schema changes that
-- were pre-implemented in BP01 with the correct column names and types. No renames
-- are needed. This migration adds only what is genuinely new: platform_revenue,
-- sub_host_subcontractors, reconciliation_review_queue, and supporting columns.

-- ── tier_definitions: add pricing and hold-period columns ────────────────────

ALTER TABLE public.tier_definitions
  ADD COLUMN IF NOT EXISTS platform_split_rate NUMERIC(5,4) NOT NULL DEFAULT 0.2000,
  ADD COLUMN IF NOT EXISTS hold_period_days     INTEGER      NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS max_seat_count       INTEGER,
  ADD COLUMN IF NOT EXISTS is_sub_host          BOOLEAN      NOT NULL DEFAULT FALSE;

-- Set per §14.5 (hold periods: 7/3/0 for Starter/Pro/Agency) and §14.3 (split rates).
-- Rates and hold periods are operator-configurable; these are the launch defaults.
UPDATE public.tier_definitions SET
  platform_split_rate = 0.3000,
  hold_period_days    = 7,
  is_sub_host         = TRUE
WHERE code = 'sub_starter';

UPDATE public.tier_definitions SET
  platform_split_rate = 0.2500,
  hold_period_days    = 3,
  is_sub_host         = TRUE
WHERE code = 'sub_pro';

UPDATE public.tier_definitions SET
  platform_split_rate = 0.2000,
  hold_period_days    = 0,
  is_sub_host         = TRUE
WHERE code = 'sub_agency';

UPDATE public.tier_definitions SET
  platform_split_rate = 0.1500,
  hold_period_days    = 0
WHERE code IN ('byo_research', 'byo_professional', 'byo_agency');

-- ── bookings: review_reason for fail-closed commission path ──────────────────

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS review_reason TEXT
    CHECK (review_reason IN (
      'commission_rate_unresolvable',
      'missing_platform_split',
      'host_adapter_unhealthy',
      'manual_review_requested'
    ));

-- ── platform_revenue — §14.12 ───────────────────────────────────────────────
-- One row per commission-received event. Negative rows for clawbacks.
-- MEMORY: tier_rate_applied is NUMERIC(5,4) (not 5,2 as the spec snippet shows);
-- §14.0.2 rule (4 decimal places) supersedes the §14.12 snippet.

CREATE TABLE public.platform_revenue (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES public.tenants(id),
  commission_id         UUID         NOT NULL REFERENCES public.commissions(id),
  amount_cents          BIGINT       NOT NULL,  -- cents per §14.0.1; negative for clawback rows
  currency              TEXT         NOT NULL DEFAULT 'USD',
  tier_rate_applied     NUMERIC(5,4) NOT NULL,  -- the platform_split_rate locked at recognition
  revenue_recognized_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  notes                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX platform_revenue_tenant_idx ON public.platform_revenue(tenant_id, revenue_recognized_at DESC);
CREATE INDEX platform_revenue_commission_idx ON public.platform_revenue(commission_id);

ALTER TABLE public.platform_revenue ENABLE ROW LEVEL SECURITY;

-- Platform revenue is service_role only on reads; tenants see their own rows for reporting.
CREATE POLICY platform_revenue_select_policy ON public.platform_revenue
  FOR SELECT USING (auth_user_in_tenant(tenant_id));

CREATE POLICY platform_revenue_insert_policy ON public.platform_revenue
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY platform_revenue_update_policy ON public.platform_revenue
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY platform_revenue_delete_policy ON public.platform_revenue
  FOR DELETE USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_revenue TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_revenue TO service_role;

-- ── sub_host_subcontractors — §14.3a ─────────────────────────────────────────
-- Per BP15 requirements. The earlier 'subcontractors' table (from BP01) uses
-- payout_percent NUMERIC(5,2). This new table uses share_rate NUMERIC(5,4)
-- to comply with §14.0.2. MEMORY: both tables exist; sub_host_subcontractors
-- is the correct §14.3a implementation; the old subcontractors table may be
-- consolidated in a later cleanup pass.

CREATE TABLE public.sub_host_subcontractors (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES public.tenants(id),
  name        TEXT         NOT NULL,
  share_rate  NUMERIC(5,4) NOT NULL CHECK (share_rate >= 0 AND share_rate <= 1),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX sub_host_subcontractors_tenant_idx ON public.sub_host_subcontractors(tenant_id);

ALTER TABLE public.sub_host_subcontractors ENABLE ROW LEVEL SECURITY;

CREATE POLICY sub_host_subcontractors_select_policy ON public.sub_host_subcontractors
  FOR SELECT USING (auth_user_in_tenant(tenant_id));

CREATE POLICY sub_host_subcontractors_insert_policy ON public.sub_host_subcontractors
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY sub_host_subcontractors_update_policy ON public.sub_host_subcontractors
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY sub_host_subcontractors_delete_policy ON public.sub_host_subcontractors
  FOR DELETE USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sub_host_subcontractors TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sub_host_subcontractors TO service_role;

-- ── bookings: sub_host_subcontractors FK column ───────────────────────────────
-- The bookings table already has subcontractor_id → subcontractors.
-- Add a second column for the new §14.3a table.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS sub_host_subcontractor_id UUID
    REFERENCES public.sub_host_subcontractors(id);

-- ── payout_records: status extension ─────────────────────────────────────────
-- The original schema had status CHECK IN ('processing','paid','failed').
-- BP15 adds 'pending', 'available', 'cancelled' states per §14.6 / §14.9.
ALTER TABLE public.payout_records
  DROP CONSTRAINT IF EXISTS payout_records_status_check;

ALTER TABLE public.payout_records
  ADD CONSTRAINT payout_records_status_check
    CHECK (status IN ('pending','available','processing','paid','failed','cancelled'));

-- ── payout_records: hold_release_at ──────────────────────────────────────────
ALTER TABLE public.payout_records
  ADD COLUMN IF NOT EXISTS hold_release_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS commission_id   UUID REFERENCES public.commissions(id),
  ADD COLUMN IF NOT EXISTS payout_intent   TEXT; -- idempotency discriminant

-- Unique index on (commission_id, payout_intent) per §14.7 idempotency contract.
CREATE UNIQUE INDEX IF NOT EXISTS payout_records_commission_intent_idx
  ON public.payout_records(commission_id, payout_intent)
  WHERE commission_id IS NOT NULL AND payout_intent IS NOT NULL;

-- ── reconciliation_review_queue — §14.8 ──────────────────────────────────────
-- Holds statement rows that fall outside the auto-accept variance threshold.
-- Service_role only on admin side; no authenticated-user access needed.

CREATE TABLE public.reconciliation_review_queue (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id        UUID         REFERENCES public.commissions(id),  -- NULL for orphan rows
  provider_booking_ref TEXT,                                             -- raw ref from statement
  tenant_id            UUID         NOT NULL REFERENCES public.tenants(id),
  variance_cents       BIGINT       NOT NULL,
  source_path          TEXT         NOT NULL CHECK (source_path IN ('automated', 'manual_upload')),
  status               TEXT         NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'orphan')),
  reviewed_at          TIMESTAMPTZ,
  reviewed_by          UUID         REFERENCES public.users(id),
  notes                TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX reconciliation_review_queue_status_idx ON public.reconciliation_review_queue(status, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_review_queue TO service_role;
-- No authenticated-user RLS policy needed (admin-only table, accessed via withPlatformAdminAudit).

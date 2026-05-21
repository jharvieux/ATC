-- §5.3 Bookings, Commissions, Subcontractors
--
-- Money columns: BIGINT cents per §14.0.1.
-- Rates: NUMERIC(5,4) per §14.0.2.
-- RLS: standard four-policy set per §5.1.2.

CREATE TYPE public.booking_status AS ENUM (
  'draft',
  'submitted',
  'pending_host_review',
  'confirmed',
  'modified',
  'cancelled',
  'sailed',
  'completed'
);

CREATE TYPE public.commission_status AS ENUM (
  'expected',
  'invoiced',
  'received',
  'partial',
  'overdue',
  'disputed',
  'waived'
);

CREATE TABLE public.bookings (
  id                      UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID               NOT NULL REFERENCES public.tenants(id),
  user_id                 UUID               REFERENCES public.users(id),
  -- TODO(contacts-fk): add FK REFERENCES public.contacts(id) when contacts table lands
  primary_contact_id      UUID,
  -- TODO(group-bookings-fk): add FK REFERENCES public.group_bookings(id) when group_bookings lands
  group_booking_id        UUID,

  -- Trip details
  booking_type            TEXT               NOT NULL DEFAULT 'cruise',
  cruise_line             TEXT,
  ship_name               TEXT,
  sailing_date            DATE,
  return_date             DATE,
  duration_nights         INTEGER,
  departure_port          TEXT,
  itinerary               JSONB,
  cabin_category          TEXT,
  cabin_assignment        TEXT,

  -- Host context
  host_adapter            TEXT,
  provider_booking_ref    TEXT,

  -- Financial (see §14.0 for money representation rules)
  total_amount_cents        BIGINT, -- cents per §14.0.1
  commissionable_fare_cents BIGINT, -- cents per §14.0.1
  currency                TEXT               NOT NULL DEFAULT 'USD',
  fare_breakdown          JSONB,

  -- Status
  status                  public.booking_status NOT NULL DEFAULT 'draft',
  draft_stage             TEXT,
  submitted_at            TIMESTAMPTZ,
  confirmed_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  cancellation_reason     TEXT,

  -- Misc
  notes                   TEXT,
  created_at              TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE TABLE public.commissions (
  id                          UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID               NOT NULL REFERENCES public.tenants(id),
  booking_id                  UUID               NOT NULL REFERENCES public.bookings(id),

  -- Expected (locked at booking submission; see §14.0 for money rules and §14.3 for locking rule)
  commissionable_fare_cents   BIGINT             NOT NULL, -- cents per §14.0.1
  commission_rate             NUMERIC(5,4)       NOT NULL,
  platform_split_rate         NUMERIC(5,4)       NOT NULL,
  gross_commission_cents      BIGINT             NOT NULL, -- cents per §14.0.1
  host_booking_fee_cents      BIGINT             NOT NULL DEFAULT 0, -- cents per §14.0.1
  host_booking_fee_rule_ref   TEXT,
  net_commission_cents        BIGINT             NOT NULL, -- cents per §14.0.1
  platform_retained_cents     BIGINT             NOT NULL, -- cents per §14.0.1
  subhost_payable_cents       BIGINT             NOT NULL, -- cents per §14.0.1
  currency                    TEXT               NOT NULL DEFAULT 'USD',
  expected_payment_date       DATE,

  -- Actual (after statement)
  received_commission_cents   BIGINT, -- cents per §14.0.1
  payment_received_date       DATE,

  -- Status
  status                      public.commission_status NOT NULL DEFAULT 'expected',
  statement_period            DATERANGE,
  statement_line_ref          TEXT,

  -- Dispute
  dispute_initiated_by        TEXT               CHECK (dispute_initiated_by IN ('tenant','platform','host')),
  dispute_status              TEXT,
  dispute_opened_at           TIMESTAMPTZ,
  dispute_resolved_at         TIMESTAMPTZ,
  dispute_resolution_notes    TEXT,

  -- Audit
  created_at                  TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE TABLE public.subcontractors (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name            TEXT         NOT NULL,
  payout_percent  NUMERIC(5,2) NOT NULL CHECK (payout_percent BETWEEN 0 AND 100),
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX subcontractors_tenant_idx ON public.subcontractors(tenant_id);

-- Bookings get an optional reference to a subcontractor (set by the sub-host)
ALTER TABLE public.bookings ADD COLUMN subcontractor_id UUID REFERENCES public.subcontractors(id);

-- ── RLS: bookings ───────────────────────────────────────────────────────────

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY bookings_select_policy ON public.bookings
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY bookings_insert_policy ON public.bookings
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY bookings_update_policy ON public.bookings
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY bookings_delete_policy ON public.bookings
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── RLS: commissions ────────────────────────────────────────────────────────

ALTER TABLE public.commissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY commissions_select_policy ON public.commissions
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY commissions_insert_policy ON public.commissions
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY commissions_update_policy ON public.commissions
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY commissions_delete_policy ON public.commissions
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── RLS: subcontractors ─────────────────────────────────────────────────────

ALTER TABLE public.subcontractors ENABLE ROW LEVEL SECURITY;

CREATE POLICY subcontractors_select_policy ON public.subcontractors
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY subcontractors_insert_policy ON public.subcontractors
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY subcontractors_update_policy ON public.subcontractors
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY subcontractors_delete_policy ON public.subcontractors
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bookings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bookings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commissions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commissions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subcontractors TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subcontractors TO service_role;

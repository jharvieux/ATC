-- §12.4 — Quotes table.
-- Financial columns follow the spec's NUMERIC(12,2) — these are proposed/display
-- amounts that include fractional dollars (e.g., per-day rates), unlike the
-- BIGINT-cents convention used for settled money in commissions (§14.0.1).
-- The distinction is intentional: quotes are customer-facing proposals, not
-- ledger entries.

CREATE TABLE public.quotes (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID          NOT NULL REFERENCES public.tenants(id),
  contact_id              UUID          NOT NULL REFERENCES public.contacts(id),
  user_id                 UUID          REFERENCES public.users(id),

  -- Trip details
  cruise_line             TEXT,
  ship_name               TEXT,
  sailing_date            DATE,
  duration_nights         INTEGER,
  cabin_category          TEXT,
  passenger_count         INTEGER,

  -- Financial (NUMERIC(12,2) per §12.4 — display amounts, not ledger cents)
  commissionable_fare     NUMERIC(12,2),
  non_commissionable_total NUMERIC(12,2),
  total_amount            NUMERIC(12,2),

  -- Lifecycle
  status                  TEXT          NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','sent','viewed','accepted','declined','expired','converted')),
  sent_at                 TIMESTAMPTZ,
  viewed_at               TIMESTAMPTZ,
  accepted_at             TIMESTAMPTZ,
  declined_at             TIMESTAMPTZ,
  declined_reason         TEXT,
  valid_until             TIMESTAMPTZ,

  -- Conversion
  converted_to_booking_id UUID          REFERENCES public.bookings(id) ON DELETE SET NULL,

  -- Display
  show_breakdown_to_customer BOOLEAN    NOT NULL DEFAULT TRUE,
  custom_notes            TEXT,

  -- Audit
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX quotes_tenant_status_idx ON public.quotes(tenant_id, status);
CREATE INDEX quotes_contact_idx       ON public.quotes(tenant_id, contact_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY quotes_select_policy ON public.quotes
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY quotes_insert_policy ON public.quotes
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY quotes_update_policy ON public.quotes
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY quotes_delete_policy ON public.quotes
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.quotes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quotes TO service_role;

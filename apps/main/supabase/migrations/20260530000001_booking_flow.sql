-- §20 — Booking flow schema scaffolding.
--
-- Extends the existing bookings table with entry_point and new status values.
-- Adds booking_passengers (DOB-not-ages with estimated-DOB gate per §20.5)
-- and booking_options (add-ons / insurance) for the multi-traveler flow.

-- ── bookings: new columns ────────────────────────────────────────────────────
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS entry_point TEXT
    CHECK (entry_point IN (
      'quote_accepted','ai_chat','group_invitation','direct_cta','price_watch'
    ));

-- Extend the booking_status enum with values needed for §20 flow.
-- ADD VALUE is safe to run multiple times (IF NOT EXISTS guards are not needed
-- because the migration runner is idempotent by timestamp).
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'pending_customer_reconfirmation' AFTER 'pending_host_review';
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'rejected' AFTER 'pending_customer_reconfirmation';
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'no_show' AFTER 'cancelled';
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'refunded' AFTER 'no_show';

-- ── booking_passengers ────────────────────────────────────────────────────────
-- One row per traveler on the booking. Captures legal names + DOB (not ages)
-- per §20.2. date_of_birth_is_estimated = true blocks submission until resolved
-- (§20.5 DOB confirmation gate).
CREATE TABLE public.booking_passengers (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                  UUID        NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  tenant_id                   UUID        NOT NULL REFERENCES public.tenants(id),
  contact_id                  UUID        REFERENCES public.contacts(id),
  legal_first_name            TEXT        NOT NULL,
  legal_last_name             TEXT        NOT NULL,
  date_of_birth               DATE        NOT NULL,
  date_of_birth_is_estimated  BOOLEAN     NOT NULL DEFAULT FALSE,
  passport_number_encrypted   TEXT,
  passport_expiry             DATE,
  passport_country            TEXT,
  is_lead_passenger           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX booking_passengers_booking_id_idx ON public.booking_passengers(booking_id);
CREATE INDEX booking_passengers_contact_id_idx ON public.booking_passengers(contact_id);

ALTER TABLE public.booking_passengers ENABLE ROW LEVEL SECURITY;

CREATE POLICY booking_passengers_select ON public.booking_passengers
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY booking_passengers_insert ON public.booking_passengers
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY booking_passengers_update ON public.booking_passengers
  FOR UPDATE USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY booking_passengers_delete ON public.booking_passengers
  FOR DELETE USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_passengers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_passengers TO service_role;

-- ── booking_options ───────────────────────────────────────────────────────────
-- Optional add-ons per booking (insurance, beverage package, specialty dining, etc.)
CREATE TABLE public.booking_options (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID        NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  tenant_id    UUID        NOT NULL REFERENCES public.tenants(id),
  option_kind  TEXT        NOT NULL,
  option_value JSONB       NOT NULL,
  price_cents  BIGINT      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX booking_options_booking_id_idx ON public.booking_options(booking_id);

ALTER TABLE public.booking_options ENABLE ROW LEVEL SECURITY;

CREATE POLICY booking_options_select ON public.booking_options
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY booking_options_insert ON public.booking_options
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY booking_options_update ON public.booking_options
  FOR UPDATE USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY booking_options_delete ON public.booking_options
  FOR DELETE USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_options TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_options TO service_role;

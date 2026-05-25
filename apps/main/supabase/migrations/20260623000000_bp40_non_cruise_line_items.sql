-- BP40 §40 — Non-cruise line items (flights, hotels, transfers,
-- excursions, insurance, other).
--
-- Single table with type discriminator + JSONB for per-type fields
-- (§40.2.2 design choice).

CREATE TABLE IF NOT EXISTS public.booking_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,

  item_type TEXT NOT NULL CHECK (item_type IN (
    'flight','hotel','transfer','excursion','insurance','other'
  )),
  description TEXT NOT NULL,

  supplier_name TEXT,
  supplier_booking_ref TEXT,
  is_cruise_line_supplied BOOLEAN NOT NULL DEFAULT FALSE,

  start_date DATE,
  end_date   DATE,

  customer_cost_cents BIGINT NOT NULL DEFAULT 0,
  supplier_net_cents  BIGINT,
  commissionable BOOLEAN NOT NULL DEFAULT FALSE,
  commission_rate NUMERIC(5,4),
  expected_commission_cents BIGINT,
  received_commission_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',

  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','booked','confirmed','cancelled','completed')),
  cancellation_reason TEXT,

  item_details JSONB,

  -- §40.6 — agent toggle for "show on itinerary" (defaults false for 'other').
  include_in_itinerary BOOLEAN NOT NULL DEFAULT TRUE,

  created_by_user_id UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bli_booking_idx
  ON public.booking_line_items(booking_id);
CREATE INDEX IF NOT EXISTS bli_tenant_type_idx
  ON public.booking_line_items(tenant_id, item_type);
CREATE INDEX IF NOT EXISTS bli_supplier_ref_idx
  ON public.booking_line_items(tenant_id, supplier_booking_ref)
  WHERE supplier_booking_ref IS NOT NULL;
-- For the "Components" bulk view per §40.5.3.
CREATE INDEX IF NOT EXISTS bli_tenant_status_start_idx
  ON public.booking_line_items(tenant_id, status, start_date)
  WHERE status IN ('planned','booked','confirmed');

ALTER TABLE public.booking_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY bli_select ON public.booking_line_items
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY bli_insert ON public.booking_line_items
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY bli_update ON public.booking_line_items
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY bli_delete ON public.booking_line_items
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_line_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_line_items TO service_role;

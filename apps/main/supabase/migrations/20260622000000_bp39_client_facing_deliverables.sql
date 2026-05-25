-- BP39 §39 — Client-facing deliverables: trip itinerary + trip resources.
--
-- Two tokenized public surfaces per booking. PDF generation only for the
-- itinerary (resources page value is in live clickable links).
-- §39.4 PII posture: NO document storage — links and metadata only.

-- ── 39.2.5 trip_itineraries ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trip_itineraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,

  access_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','archived')),

  agent_notes TEXT,
  cover_image_url TEXT,
  day_overrides JSONB,

  sent_at      TIMESTAMPTZ,
  archived_at  TIMESTAMPTZ,
  last_pdf_generated_at TIMESTAMPTZ,
  pdf_storage_key TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS trip_itineraries_token_idx
  ON public.trip_itineraries(access_token)
  WHERE status <> 'draft';

ALTER TABLE public.trip_itineraries ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_itineraries_select ON public.trip_itineraries
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY trip_itineraries_insert ON public.trip_itineraries
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY trip_itineraries_update ON public.trip_itineraries
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY trip_itineraries_delete ON public.trip_itineraries
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_itineraries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_itineraries TO service_role;

-- ── 39.3.4 trip_resources ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trip_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,

  access_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','archived')),

  sections JSONB,
  agent_contact JSONB,
  packing_checklist TEXT,

  published_at TIMESTAMPTZ,
  archived_at  TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS trip_resources_token_idx
  ON public.trip_resources(access_token)
  WHERE status = 'published';

ALTER TABLE public.trip_resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_resources_select ON public.trip_resources
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY trip_resources_insert ON public.trip_resources
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY trip_resources_update ON public.trip_resources
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY trip_resources_delete ON public.trip_resources
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_resources TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_resources TO service_role;

-- ── Storage bucket for itinerary PDFs ─────────────────────────────────
-- Wrapped in pg_namespace guard so CI/local Postgres without the Supabase
-- storage extension skip cleanly. Production Supabase always has it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
    EXECUTE $sql$
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES (
        'trip-itinerary-pdfs',
        'trip-itinerary-pdfs',
        FALSE,
        20 * 1024 * 1024,
        ARRAY['application/pdf']::TEXT[]
      )
      ON CONFLICT (id) DO NOTHING
    $sql$;
  END IF;
END;
$$;

-- The public itinerary endpoint serves PDFs via signed URLs from the
-- application, not via direct bucket policies. No anon read policy needed.

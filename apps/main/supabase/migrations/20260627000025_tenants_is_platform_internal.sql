-- #699 — Internal-tenant billing exemption.
--
-- The platform-owned "Booking" tenant (and any future ATC-owned tenant
-- lines of business) need to run with status='active' so branding/RLS
-- behave normally, but must NOT be subject to the payment gate (the
-- platform doesn't bill itself).
--
-- Previously the only way to skip the payment gate was to leave the
-- tenant in status='onboarding' — but that conflates two semantically
-- different states and reuses the (separately-broken, see #700)
-- onboarding-exemption mechanism. This column is the explicit signal.
--
-- Boolean, NOT NULL, default FALSE so existing rows are unaffected and
-- no SaaS tenant accidentally gets the exemption.

ALTER TABLE public.tenants
  ADD COLUMN is_platform_internal BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.tenants.is_platform_internal IS
  'TRUE for ATC-owned tenants that should bypass the payment gate (#699). '
  'Set sparingly — every TRUE row skips billing enforcement.';

-- Partial index — most tenants will have FALSE; the index only stores
-- the small set of internal tenants for fast lookup.
CREATE INDEX tenants_is_platform_internal_idx
  ON public.tenants (id)
  WHERE is_platform_internal = TRUE;

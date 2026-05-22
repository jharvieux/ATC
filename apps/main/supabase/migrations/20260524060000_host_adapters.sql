-- §13.3 — Host adapter registry (platform-scoped, not tenant-scoped).
-- SELECT to authenticated so tenants can browse the catalog.
-- INSERT/UPDATE/DELETE platform-admin only (service_role).
-- Documented in db/rls-exceptions.txt.

CREATE TABLE public.host_adapters (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_id              TEXT         NOT NULL UNIQUE,
  display_name            TEXT         NOT NULL,
  implementation_path     TEXT         NOT NULL,
  config                  JSONB        NOT NULL DEFAULT '{}',
  capabilities            JSONB        NOT NULL DEFAULT '{}',
  is_active               BOOLEAN      NOT NULL DEFAULT TRUE,
  is_default              BOOLEAN      NOT NULL DEFAULT FALSE,
  health_check_status     TEXT         CHECK (health_check_status IN ('healthy','degraded','unhealthy','unknown')),
  health_check_last_at    TIMESTAMPTZ,
  health_check_message    TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Only one adapter can be the default at a time.
CREATE UNIQUE INDEX host_adapters_default_idx ON public.host_adapters(is_default) WHERE is_default = TRUE;

ALTER TABLE public.host_adapters ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_adapters_select_policy ON public.host_adapters
  FOR SELECT
  USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

GRANT SELECT ON public.host_adapters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.host_adapters TO service_role;

-- ── Seed fallback adapter (§13.6) ────────────────────────────────────────────
-- The fallback email adapter is the platform default until a real host adapter
-- is onboarded. This is confirmed in MEMORY.md D-048.

INSERT INTO public.host_adapters (
  adapter_id,
  display_name,
  implementation_path,
  config,
  capabilities,
  is_active,
  is_default,
  health_check_status
) VALUES (
  'fallback-email',
  'Manual / Email Fallback',
  'apps/main/src/lib/host-adapters/fallback-email/adapter.ts',
  '{}',
  '{
    "supports_inventory_search": false,
    "supports_real_time_booking": true,
    "supports_modification": false,
    "supports_cancellation": false,
    "supports_commission_api": false,
    "booking_types": [],
    "cruise_lines_supported": [],
    "commission_currency": "USD",
    "payment_lag_days_typical": 0
  }',
  TRUE,
  TRUE,
  'healthy'
);

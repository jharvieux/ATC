-- §12.6 — Host booking fee configs (platform-scoped) and tenant overrides.
-- host_booking_fee_configs: platform-wide per-adapter fee schedules (no tenant_id).
-- tenant_host_fee_overrides: tenant-specific arrangements with their host.

CREATE TABLE public.host_booking_fee_configs (
  id                             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  host_adapter                   TEXT          NOT NULL,
  fee_type                       TEXT          NOT NULL CHECK (fee_type IN ('none','flat','percent','tiered')),
  flat_fee_amount                NUMERIC(12,2),
  percent_of_commission          NUMERIC(5,4),
  tiered_rules                   JSONB,
  minimum_commission_threshold   NUMERIC(12,2),
  effective_from                 DATE          NOT NULL,
  effective_to                   DATE,
  created_at                     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- RLS: SELECT to authenticated (tenants can read the fee catalog).
-- INSERT/UPDATE/DELETE restricted to service_role (platform admin).
-- Documented in db/rls-exceptions.txt.
ALTER TABLE public.host_booking_fee_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_booking_fee_configs_select_policy ON public.host_booking_fee_configs
  FOR SELECT
  USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

GRANT SELECT ON public.host_booking_fee_configs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.host_booking_fee_configs TO service_role;

-- ── Tenant overrides ─────────────────────────────────────────────────────────

CREATE TABLE public.tenant_host_fee_overrides (
  id                             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                      UUID          NOT NULL REFERENCES public.tenants(id),
  host_adapter                   TEXT          NOT NULL,
  fee_type                       TEXT          NOT NULL CHECK (fee_type IN ('none','flat','percent','tiered')),
  flat_fee_amount                NUMERIC(12,2),
  percent_of_commission          NUMERIC(5,4),
  tiered_rules                   JSONB,
  minimum_commission_threshold   NUMERIC(12,2),
  effective_from                 DATE          NOT NULL,
  effective_to                   DATE,
  created_at                     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX tenant_host_fee_overrides_tenant_idx ON public.tenant_host_fee_overrides(tenant_id);

ALTER TABLE public.tenant_host_fee_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_host_fee_overrides_select_policy ON public.tenant_host_fee_overrides
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY tenant_host_fee_overrides_insert_policy ON public.tenant_host_fee_overrides
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY tenant_host_fee_overrides_update_policy ON public.tenant_host_fee_overrides
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY tenant_host_fee_overrides_delete_policy ON public.tenant_host_fee_overrides
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_host_fee_overrides TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_host_fee_overrides TO service_role;

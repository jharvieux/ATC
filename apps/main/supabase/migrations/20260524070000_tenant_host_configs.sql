-- §13.4 — Tenant host configurations with encrypted credentials.
-- credentials JSONB stores: { "ciphertext": "...", "key_id": "v1" }
-- per §13.5.1. Never read raw — always through credential-cipher.ts.

CREATE TABLE public.tenant_host_configs (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID         NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  adapter_id              TEXT         NOT NULL REFERENCES public.host_adapters(adapter_id),
  -- Application-layer encrypted via AES-256-GCM per §13.5.
  -- Never read raw — always go through apps/main/src/lib/crypto/credential-cipher.ts.
  credentials             JSONB        NOT NULL,
  credential_status       TEXT         NOT NULL DEFAULT 'pending'
                          CHECK (credential_status IN ('pending','verified','rejected','expired','revoked')),
  credential_verified_at  TIMESTAMPTZ,
  is_active               BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, adapter_id)
);

CREATE INDEX tenant_host_configs_tenant_idx ON public.tenant_host_configs(tenant_id);

ALTER TABLE public.tenant_host_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_host_configs_select_policy ON public.tenant_host_configs
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY tenant_host_configs_insert_policy ON public.tenant_host_configs
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY tenant_host_configs_update_policy ON public.tenant_host_configs
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY tenant_host_configs_delete_policy ON public.tenant_host_configs
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_host_configs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_host_configs TO service_role;

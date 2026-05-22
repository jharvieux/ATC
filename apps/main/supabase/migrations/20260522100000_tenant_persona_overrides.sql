-- §9.5 — tenant_persona_overrides
-- Stores per-tenant customizations for AI persona display and system prompt.
-- Tier-gating is enforced at the application layer (see build-system-prompt.ts):
--   display_name_override: null for byo_research tier
--   system_prompt_addendum: null for any non-agency tier
-- The addendum is Haiku-screened before write (see screen-addendum.ts).

CREATE TABLE public.tenant_persona_overrides (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  persona_slug            TEXT        NOT NULL,
  display_name_override   TEXT,
  system_prompt_addendum  TEXT,
  is_disabled             BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, persona_slug)
);

CREATE INDEX tenant_persona_overrides_tenant_id_idx
  ON public.tenant_persona_overrides (tenant_id);

-- RLS — four-policy set per §5.1.2
ALTER TABLE public.tenant_persona_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_persona_overrides_select"
  ON public.tenant_persona_overrides
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY "tenant_persona_overrides_insert"
  ON public.tenant_persona_overrides
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY "tenant_persona_overrides_update"
  ON public.tenant_persona_overrides
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY "tenant_persona_overrides_delete"
  ON public.tenant_persona_overrides
  FOR DELETE
  USING (auth_user_in_tenant(tenant_id));

-- Explicit grants per D-032 and D-039
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_persona_overrides TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_persona_overrides TO service_role;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_persona_overrides_updated_at
  BEFORE UPDATE ON public.tenant_persona_overrides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

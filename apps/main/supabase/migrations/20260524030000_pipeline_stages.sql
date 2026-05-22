-- §12.3 — Pipeline stages (tenant-configurable).
-- Deliberate soft reference: contacts.pipeline_stage_key is a TEXT column
-- rather than a hard FK to pipeline_stages(stage_key), because the composite
-- (tenant_id, stage_key) unique key would require a composite FK — adding
-- complexity with little benefit. Application layer validates the stage key
-- exists for the contact's tenant at write time.

CREATE TABLE public.pipeline_stages (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES public.tenants(id),
  stage_key       TEXT         NOT NULL,
  display_name    TEXT         NOT NULL,
  ordinal         INTEGER      NOT NULL,
  is_terminal     BOOLEAN      NOT NULL DEFAULT FALSE,
  is_lost_status  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, stage_key)
);

CREATE INDEX pipeline_stages_tenant_idx ON public.pipeline_stages(tenant_id, ordinal);

-- Soft reference: contacts can carry a pipeline stage key without a hard FK.
ALTER TABLE public.contacts ADD COLUMN pipeline_stage_key TEXT;

-- ── Seed default stages for all existing tenants ──────────────────────────────
-- On new tenant creation, the tenant-create flow (apps/main/src/app/api/tenants)
-- should also call this seed. This migration covers existing rows at deploy time.

INSERT INTO public.pipeline_stages (tenant_id, stage_key, display_name, ordinal, is_terminal, is_lost_status)
SELECT
  t.id,
  s.stage_key,
  s.display_name,
  s.ordinal,
  s.is_terminal,
  s.is_lost_status
FROM public.tenants t
CROSS JOIN (VALUES
  ('lead',               'Lead',                1, FALSE, FALSE),
  ('qualified',          'Qualified',           2, FALSE, FALSE),
  ('quote_sent',         'Quote Sent',          3, FALSE, FALSE),
  ('quote_accepted',     'Quote Accepted',      4, FALSE, FALSE),
  ('booked',             'Booked',              5, FALSE, FALSE),
  ('sailed',             'Sailed',              6, TRUE,  FALSE),
  ('lost',               'Lost',                7, TRUE,  TRUE),
  ('post_trip_followup', 'Post-Trip Follow-up', 8, FALSE, FALSE)
) AS s(stage_key, display_name, ordinal, is_terminal, is_lost_status)
ON CONFLICT (tenant_id, stage_key) DO NOTHING;

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipeline_stages_select_policy ON public.pipeline_stages
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY pipeline_stages_insert_policy ON public.pipeline_stages
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY pipeline_stages_update_policy ON public.pipeline_stages
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY pipeline_stages_delete_policy ON public.pipeline_stages
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_stages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_stages TO service_role;

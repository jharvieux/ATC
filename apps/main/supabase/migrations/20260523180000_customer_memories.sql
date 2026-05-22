-- §11.1 customer_memories schema
-- One row per (tenant_id, user_id) pair — enforced by UNIQUE constraint.
-- contact_id is a bare UUID without FK (contacts table lands in Prompt 13;
-- FK will be added by 0021_resolve_customer_memories_contact_fk.sql).
-- TODO(contacts-fk)

CREATE TABLE public.customer_memories (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id                UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  contact_id             UUID,                                         -- TODO(contacts-fk)

  -- JSONB preference fields per §11.1
  preferences            JSONB,
  travel_history         JSONB,
  family_composition     JSONB,
  accessibility_needs    JSONB,
  dietary_restrictions   JSONB,
  loyalty_programs       JSONB,
  important_dates        JSONB,
  notes_freeform         TEXT,

  -- Rapport state per §11.1
  rapport_tone_level     INTEGER CHECK (rapport_tone_level BETWEEN 1 AND 5),
  rapport_signals        JSONB,
  rapport_level_set_at   TIMESTAMPTZ,

  -- Extraction metadata per §11.2
  last_extracted_at      TIMESTAMPTZ,
  conversation_count     INTEGER NOT NULL DEFAULT 0,

  -- DOB lifecycle flag per §11.5
  awaiting_dob_reprompt  BOOLEAN NOT NULL DEFAULT FALSE,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, user_id)
);

-- Enforce row-level tenant isolation per §5.1.2
ALTER TABLE public.customer_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_memories_tenant_select ON public.customer_memories
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY customer_memories_tenant_insert ON public.customer_memories
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id));

CREATE POLICY customer_memories_tenant_update ON public.customer_memories
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

CREATE POLICY customer_memories_tenant_delete ON public.customer_memories
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id));

-- Support tenant-scoped lookups by user
CREATE INDEX customer_memories_tenant_user_idx ON public.customer_memories(tenant_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_memories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_memories TO service_role;

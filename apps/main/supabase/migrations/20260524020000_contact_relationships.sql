-- §12.2 — Contact relationships (directed graph with relationship type).
-- Canonical relationship_type values (free text per spec, not enumed):
--   'spouse', 'partner', 'parent_of', 'child_of', 'sibling', 'friend', 'colleague'
-- Both FK ends use ON DELETE CASCADE so removing a contact removes its edges.
-- The tenant_id column is the authoritative scope; the FK structure guarantees
-- that both endpoints are reachable within the same tenant (otherwise RLS on
-- contacts prevents the FK from resolving).

CREATE TABLE public.contact_relationships (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES public.tenants(id),
  from_contact_id   UUID         NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  to_contact_id     UUID         NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  relationship_type TEXT         NOT NULL,
  notes             TEXT,
  source            TEXT,  -- 'manual', 'ai_inferred'
  confidence        NUMERIC(3,2),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, from_contact_id, to_contact_id, relationship_type)
);

CREATE INDEX contact_relationships_tenant_idx     ON public.contact_relationships(tenant_id);
CREATE INDEX contact_relationships_from_idx       ON public.contact_relationships(from_contact_id);
CREATE INDEX contact_relationships_to_idx         ON public.contact_relationships(to_contact_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.contact_relationships ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_relationships_select_policy ON public.contact_relationships
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY contact_relationships_insert_policy ON public.contact_relationships
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY contact_relationships_update_policy ON public.contact_relationships
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY contact_relationships_delete_policy ON public.contact_relationships
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_relationships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_relationships TO service_role;

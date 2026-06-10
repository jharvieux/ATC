-- #963 — Tenant-editable outgoing email templates.
--
-- One row per (tenant, email_type) holding the tenant's subject and/or body
-- override. NULL subject_template or body_template means "use the platform
-- default" for that part; a row with both NULL is meaningless, so a CHECK
-- forbids it (reset-to-default is a DELETE, not a NULL-out).
--
-- email_type values are governed by the app-side registry
-- (apps/main/src/lib/email/template-registry.ts), not a DB enum — adding an
-- email type must not require a migration. Send paths only ever look up
-- types present in the registry, so an unknown email_type row is inert.
--
-- Access model:
--   - SELECT: any active member of the tenant (RLS) — the settings page
--     shows current overrides to all roles.
--   - INSERT/UPDATE/DELETE: service-role only (RLS false). Writes are
--     owner-only per the RBAC matrix (email_templates:write), which RLS
--     cannot express; the owner-gated /api/tenant/email-templates routes
--     write through the tenantClient proxy (service role + injected
--     tenant_id filter). Denying authenticated writes outright is the
--     fail-closed posture.

CREATE TABLE public.tenant_email_templates (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email_type       TEXT        NOT NULL CHECK (char_length(email_type) BETWEEN 1 AND 100),
  subject_template TEXT        NULL CHECK (char_length(subject_template) <= 300),
  body_template    TEXT        NULL CHECK (char_length(body_template) <= 10000),
  updated_by       TEXT        NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_email_templates_not_empty
    CHECK (subject_template IS NOT NULL OR body_template IS NOT NULL),
  CONSTRAINT tenant_email_templates_tenant_type_ux UNIQUE (tenant_id, email_type)
);

ALTER TABLE public.tenant_email_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_email_templates_select_policy" ON public.tenant_email_templates
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY "tenant_email_templates_insert_policy" ON public.tenant_email_templates
  FOR INSERT TO PUBLIC
  WITH CHECK (false);

CREATE POLICY "tenant_email_templates_update_policy" ON public.tenant_email_templates
  FOR UPDATE TO PUBLIC
  USING (false)
  WITH CHECK (false);

CREATE POLICY "tenant_email_templates_delete_policy" ON public.tenant_email_templates
  FOR DELETE TO PUBLIC
  USING (false);

-- Grants mirror the RLS surface (voice_profiles grants-snapshot lesson):
-- authenticated gets only SELECT; all writes go through service_role.
GRANT SELECT ON public.tenant_email_templates TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_email_templates TO service_role;

COMMENT ON TABLE public.tenant_email_templates IS
  'Per-tenant subject/body overrides for outgoing customer emails (#963). '
  'email_type matches email_log.template_id and the app-side registry. '
  'NULL part = platform default; reset-to-default deletes the row.';

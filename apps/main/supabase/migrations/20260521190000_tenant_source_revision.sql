-- §8.3: source_revision counter on tenants
--
-- Incremented by trigger whenever status, tenant_type, or display_name changes.
-- The RAG shadow table uses this to detect stale webhook deliveries.
-- Intentionally NOT incremented on every row update — only fields the RAG
-- side cares about.

ALTER TABLE public.tenants
  ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.tenants_increment_source_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status)
     OR (NEW.tenant_type IS DISTINCT FROM OLD.tenant_type)
     OR (NEW.display_name IS DISTINCT FROM OLD.display_name)
  THEN
    NEW.source_revision := OLD.source_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tenants_increment_source_revision() FROM public;

CREATE TRIGGER tenants_source_revision_trigger
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.tenants_increment_source_revision();

-- ── Grants ───────────────────────────────────────────────────────────────────
-- No new table — only column + trigger added to existing tenants table.
-- Existing grants on public.tenants (from migration 20260521120003_grants.sql
-- and 20260521140000_service_role_grants.sql) cover the new column.

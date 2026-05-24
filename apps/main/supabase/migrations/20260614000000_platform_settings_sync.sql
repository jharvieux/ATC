-- D-041 follow-up — Cross-project sync for platform_settings.
--
-- 1. Auto-bump updated_at on UPDATE so the sender can derive a monotonic
--    source_revision (EXTRACT(EPOCH FROM updated_at)::INTEGER). Before this
--    trigger, callers had to remember to set updated_at manually; some did
--    (denylist route does not), so the receiver had no reliable stale-event
--    guard.
-- 2. Generalize pending_rag_sync to accept platform_settings.* event types
--    and tenant-less rows (platform settings have no tenant scope).

-- ── 1. Trigger: auto-bump updated_at ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_platform_settings_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_settings_updated_at_trg ON public.platform_settings;

CREATE TRIGGER platform_settings_updated_at_trg
  BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_platform_settings_updated_at();

-- ── 2. pending_rag_sync: extend event_type CHECK; allow null tenant_id ──

ALTER TABLE public.pending_rag_sync
  ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE public.pending_rag_sync
  DROP CONSTRAINT IF EXISTS pending_rag_sync_event_type_check;

ALTER TABLE public.pending_rag_sync
  ADD CONSTRAINT pending_rag_sync_event_type_check CHECK (event_type IN (
    'tenant.created',
    'tenant.status_changed',
    'tenant.terminated',
    'tenant.metadata_updated',
    'platform_settings.updated'
  ));

-- Belt-and-suspenders: tenant.* events still require a tenant_id; only
-- platform_settings.* events may carry NULL.
ALTER TABLE public.pending_rag_sync
  ADD CONSTRAINT pending_rag_sync_tenant_required_for_tenant_events CHECK (
    NOT (event_type LIKE 'tenant.%') OR tenant_id IS NOT NULL
  );

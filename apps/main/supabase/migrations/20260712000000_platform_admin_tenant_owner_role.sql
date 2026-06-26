-- Ensure platform admins always hold role='tenant_owner' in platform-internal
-- tenants so the Tenant Admin Console (/settings dashboard) remains accessible.
--
-- Root cause: migration 20260628000002 changed users.role DEFAULT to 'viewer'.
-- The auth callback upsert doesn't set role explicitly, so a platform admin
-- signing in on a new device would get role='viewer' in the default tenant,
-- causing assertPermission to deny TenantUsage:read → "Could not load
-- dashboard data".
--
-- Part 1: one-time fix for any existing under-privileged platform admin rows.
-- Part 2: BEFORE INSERT trigger that enforces the invariant on future upserts.
-- UPDATE is intentionally excluded — the trigger only fires on INSERT so it
-- doesn't fight with deliberate role changes made by migrations or tooling.

UPDATE public.users u
SET role = 'tenant_owner'
FROM public.platform_admins pa
JOIN public.tenants t ON t.is_platform_internal = TRUE
WHERE u.auth_user_id = pa.auth_user_id
  AND u.tenant_id = t.id
  AND u.role <> 'tenant_owner';

-- ─── trigger ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ensure_platform_admin_tenant_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.platform_admins WHERE auth_user_id = NEW.auth_user_id
  ) AND EXISTS (
    SELECT 1 FROM public.tenants WHERE id = NEW.tenant_id AND is_platform_internal = TRUE
  ) THEN
    NEW.role := 'tenant_owner';
  END IF;
  RETURN NEW;
END;
$$;

-- Direct EXECUTE is revoked — the function is only invoked by the trigger.
REVOKE EXECUTE ON FUNCTION public.ensure_platform_admin_tenant_owner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ensure_platform_admin_tenant_owner() FROM anon, authenticated;

CREATE TRIGGER users_ensure_platform_admin_owner
  BEFORE INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.ensure_platform_admin_tenant_owner();

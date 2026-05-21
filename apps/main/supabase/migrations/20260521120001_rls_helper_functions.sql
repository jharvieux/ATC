-- Migration: RLS helper functions
-- Spec refs: §5.1 (helper bodies), §5.1.1 (SECURITY DEFINER convention)
--
-- Both functions are SECURITY DEFINER with a locked search_path = '' to
-- prevent the canonical Postgres privilege-escalation pattern. Every
-- SECURITY DEFINER function on the platform must follow the §5.1.1
-- conventions: SET search_path = '', fully qualified table refs, created
-- in public schema, REVOKE from public + GRANT to specific role. The
-- migration lint gate enforces these.

-- ---------------------------------------------------------------------------
-- auth_user_in_tenant(target_tenant_id UUID)
--
-- Returns TRUE if the authenticated user has an active row in the named
-- tenant. Does NOT check tenant status — pair with tenant_is_active when
-- the policy also needs the tenant to be operational.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_user_in_tenant(target_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE auth_user_id = auth.uid()
      AND tenant_id    = target_tenant_id
      AND status       = 'active'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.auth_user_in_tenant(UUID) FROM public;
GRANT  EXECUTE ON FUNCTION public.auth_user_in_tenant(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- tenant_is_active(target_tenant_id UUID)
--
-- Returns TRUE only when the named tenant is in 'active' status. Tenants
-- in suspended, terminated, pending_review, or onboarding status return
-- FALSE — used in WITH CHECK clauses to block user-initiated writes at
-- the database layer even if app-layer checks are skipped or buggy.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tenant_is_active(target_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenants
    WHERE id     = target_tenant_id
      AND status = 'active'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.tenant_is_active(UUID) FROM public;
GRANT  EXECUTE ON FUNCTION public.tenant_is_active(UUID) TO authenticated;

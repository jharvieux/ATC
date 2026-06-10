-- #969 — Backfill: platform-tenant customers must be role='viewer'.
--
-- WHY: migration 20260625000001 added users.role with DEFAULT 'tenant_owner'
-- and backfilled every existing row to tenant_owner. 20260628000002 flipped
-- the default to 'viewer', but a column-default change only affects future
-- INSERTs — rows created before the flip kept tenant_owner. On the
-- platform-internal (Booking) tenant those rows are end customers, so they
-- hold owner-level grants (and, since PR #967, see the owner nav).
--
-- WHAT: set role='viewer' for users on tenants flagged is_platform_internal,
-- EXCLUDING anyone in platform_admins (matched by auth_user_id OR email,
-- case-insensitive) — the operator's own accounts must not be demoted.
-- Operator-approved prod data change (issue #969 comment, 2026-06-10).
--
-- HOW TO RUN: execute statement-by-statement via MCP (supabase-main
-- execute_sql). Run the BEFORE select, eyeball it, run the UPDATE (it
-- RETURNS the changed rows), then the AFTER select. Idempotent — re-running
-- the UPDATE matches zero rows.

-- ============================================================
-- 1. VERIFICATION (BEFORE): every membership row on platform-internal
--    tenants, with the would-be action. Expect customers to show
--    'will_demote_to_viewer' and operator accounts 'kept_(platform_admin)'.
-- ============================================================
SELECT
  u.id,
  u.email,
  u.role,
  u.status,
  t.display_name AS tenant_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.platform_admins pa
      WHERE pa.auth_user_id = u.auth_user_id
         OR (pa.email IS NOT NULL AND lower(pa.email) = lower(u.email))
    ) THEN 'kept_(platform_admin)'
    WHEN u.role <> 'viewer' THEN 'will_demote_to_viewer'
    ELSE 'already_viewer'
  END AS action
FROM public.users u
JOIN public.tenants t ON t.id = u.tenant_id
WHERE t.is_platform_internal = TRUE
ORDER BY action, u.email;

-- ============================================================
-- 2. BACKFILL: demote non-viewer rows on platform-internal tenants,
--    excluding platform_admins accounts. RETURNING shows exactly what
--    changed.
-- ============================================================
UPDATE public.users u
SET role = 'viewer'
FROM public.tenants t
WHERE t.id = u.tenant_id
  AND t.is_platform_internal = TRUE
  AND u.role <> 'viewer'
  AND NOT EXISTS (
    SELECT 1 FROM public.platform_admins pa
    WHERE pa.auth_user_id = u.auth_user_id
       OR (pa.email IS NOT NULL AND lower(pa.email) = lower(u.email))
  )
RETURNING u.id, u.email, u.role;

-- ============================================================
-- 3. VERIFICATION (AFTER): same query as step 1. Expect zero
--    'will_demote_to_viewer' rows; platform_admins accounts unchanged.
-- ============================================================
SELECT
  u.id,
  u.email,
  u.role,
  u.status,
  t.display_name AS tenant_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.platform_admins pa
      WHERE pa.auth_user_id = u.auth_user_id
         OR (pa.email IS NOT NULL AND lower(pa.email) = lower(u.email))
    ) THEN 'kept_(platform_admin)'
    WHEN u.role <> 'viewer' THEN 'will_demote_to_viewer'
    ELSE 'already_viewer'
  END AS action
FROM public.users u
JOIN public.tenants t ON t.id = u.tenant_id
WHERE t.is_platform_internal = TRUE
ORDER BY action, u.email;

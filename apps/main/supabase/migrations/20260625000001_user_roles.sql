-- §26.2 — User role column for in-tenant RBAC.
--
-- The 2026-05-25 audit (Finding 5) flagged that assertPermission was a
-- stub: it verified the caller was an active tenant member but never
-- checked whether their {role, resource, action} triple was actually
-- granted. Without this column, RBAC was unimplementable.
--
-- ROLE VALUES (initial set; can grow as features land):
--   'tenant_owner' — full power within the tenant. Agency owner.
--   'agent'        — operational: bookings, quotes, contacts, tasks. Cannot
--                    touch tenant settings (branding, host_config, personas).
--   'viewer'       — read-only across all resources.
--
-- DEFAULT: 'tenant_owner'. Existing rows backfill to tenant_owner so no
-- existing user loses access on this migration. New users (via /signup)
-- default to tenant_owner until the role-assignment UI ships; future
-- invitation flows can override.

ALTER TABLE public.users
  ADD COLUMN role TEXT NOT NULL DEFAULT 'tenant_owner'
    CHECK (role IN ('tenant_owner', 'agent', 'viewer'));

-- Index for the assertPermission-side lookup. Already indexed on
-- (auth_user_id, tenant_id); role is read alongside but doesn't need
-- its own index — selectivity is too low.
COMMENT ON COLUMN public.users.role IS
  '§26.2 RBAC role. Grants matrix is in code (apps/main/src/lib/auth/permission-grants.ts).';

-- Flip public.users.role default from 'tenant_owner' to 'viewer' (least-privilege).
--
-- 20260625000001_user_roles.sql set the default to 'tenant_owner' as an explicit
-- stopgap ("default to tenant_owner until the role-assignment UI ships"). That
-- default is unsafe for the auto-membership paths: the OAuth callback and the
-- Microsoft email-verify route upsert a public.users row WITHOUT a role, so every
-- platform-domain customer sign-in silently became a tenant OWNER of the default
-- tenant (#800). 'viewer' is the customer-facing role — resolve-post-login routes
-- a viewer (or no-membership) user to the customer chat surface.
--
-- Defense-in-depth: any future code path that inserts a users row without a role
-- now gets least-privilege, not owner. The one path that legitimately creates an
-- owner — /api/auth/signup/complete (agency provisioning) — sets role:'tenant_owner'
-- EXPLICITLY, so it is unaffected. Existing rows are untouched (SET DEFAULT only
-- affects future INSERTs). Idempotent.

ALTER TABLE public.users
  ALTER COLUMN role SET DEFAULT 'viewer';

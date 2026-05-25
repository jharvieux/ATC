-- §26 — Platform administrator session gate.
--
-- Until this migration, every /api/admin/* route relied on the value of
-- the `x-admin-user-id` request header for authorization. There was no
-- verification step — any value passed the check, including from
-- unauthenticated callers (audit Finding 1, 2026-05-25, confidence 10).
--
-- This table is the source of truth for "who is a platform admin." The
-- session gate (lib/auth/assert-platform-admin.ts) verifies the caller's
-- Supabase session JWT, then looks up auth_user_id in this table.
-- Membership in this table → platform admin. Absence → 403.
--
-- ROW MANAGEMENT:
--   This table is intentionally NOT writable from the application. The
--   first admin is seeded manually via SQL after deploy:
--     INSERT INTO platform_admins (auth_user_id, role)
--     VALUES ('<supabase-auth-user-uuid>', 'superadmin');
--   Subsequent admins can be added by an existing admin via a future
--   /api/admin/admins endpoint (out of scope for this migration).
--
-- ROLE COLUMN:
--   For now we accept any non-empty string. Spec §26 calls for a
--   permissions matrix; that lands with the RBAC work (Auth #5).
--   Common values during this transition: 'superadmin', 'reviewer',
--   'finance', 'support'.

CREATE TABLE public.platform_admins (
  auth_user_id        UUID        PRIMARY KEY,
  role                TEXT        NOT NULL CHECK (length(role) > 0),
  email               TEXT,        -- denormalized for audit-log readability
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_auth_user_id UUID,    -- the admin who added this row (NULL for seeded)
  notes               TEXT
);

-- No tenant_id — this is a platform-internal table. RLS is enabled, but
-- the policies forbid all authenticated access. Writes/reads happen via
-- service_role only (the session-gate helper uses createServiceRoleClient
-- under the hood; it's in the no-direct-service-role-import allow-list).

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- Deny everything to authenticated users. The four-policy contract
-- (per §5.1.2) requires all four declared, even if they all reject.
CREATE POLICY "platform_admins_select_deny"
  ON public.platform_admins FOR SELECT TO authenticated
  USING (false);
CREATE POLICY "platform_admins_insert_deny"
  ON public.platform_admins FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY "platform_admins_update_deny"
  ON public.platform_admins FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "platform_admins_delete_deny"
  ON public.platform_admins FOR DELETE TO authenticated
  USING (false);

-- Index on email for the rare admin-lookup-by-email query.
CREATE INDEX platform_admins_email_idx ON public.platform_admins (email)
  WHERE email IS NOT NULL;

-- §26 — Seed the first platform admin.
--
-- Run this ONCE per environment, after the platform_admins migration is
-- applied. Until at least one row exists, only the service-to-service Bearer
-- (MAIN_APP_ADMIN_API_KEY, used by RAG crons) can hit /api/admin/* — no
-- human session can.
--
-- See docs/runbooks/platform-admin-seeding.md for the full procedure.
--
-- USAGE:
--   1. Fill in the three placeholders below. The auth_user_id is the
--      Supabase auth.users.id of the human you're making a platform admin.
--      Look it up at:
--         SELECT id, email FROM auth.users WHERE email = '<email>';
--   2. Run against the main app's database:
--         psql "$SUPABASE_DB_URL" -f scripts/seed-platform-admin.sql
--   3. Confirm with:
--         SELECT auth_user_id, role, email, created_at FROM public.platform_admins;
--   4. Test by signing in as that user and hitting /(admin)/supervisor or
--      any /admin/* page. The new session gate (§26) will recognize you.

INSERT INTO public.platform_admins (auth_user_id, role, email, notes)
VALUES (
  -- auth_user_id (uuid): replace with the user's Supabase auth.users.id
  '<REPLACE-WITH-AUTH-USER-UUID>',
  -- role: 'superadmin' for the first/bootstrap admin
  'superadmin',
  -- email: denormalized for audit-log readability
  '<REPLACE-WITH-EMAIL>',
  -- notes: free text — e.g. 'Bootstrap admin for prod, 2026-05-25'
  '<REPLACE-WITH-NOTES>'
)
ON CONFLICT (auth_user_id) DO NOTHING;

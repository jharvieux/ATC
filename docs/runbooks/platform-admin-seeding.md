# Platform admin seeding runbook

**Spec ref:** §26 (admin gate) — `apps/main/supabase/migrations/20260625000000_platform_admins.sql`

After deploying the §26 admin session gate (PR #168), the platform_admins
table is empty. Until at least one row exists, **no human session can
access `/api/admin/*`** — only the service-to-service Bearer (the
`MAIN_APP_ADMIN_API_KEY` used by RAG reconcile crons) works.

This runbook walks you through making the first admin. After that, you can
add more admins via SQL or (when the future `/api/admin/admins` endpoint
ships) through the admin UI.

## Pre-requisites

1. **The platform_admins migration has been applied** to the target database.
   Confirm:
   ```sql
   SELECT to_regclass('public.platform_admins') IS NOT NULL AS exists;
   ```

2. **The person you're making an admin has already signed up** to the app
   (their `auth.users` row exists). They don't need to be in `public.users`
   for any specific tenant — platform admins are scoped to the platform,
   not a tenant.

3. **You have access to the database via psql or the Supabase SQL editor.**

## Procedure

### Step 1. Find the auth_user_id

```sql
SELECT id, email, last_sign_in_at
FROM auth.users
WHERE email = '<their-email>';
```

Copy the `id` value — it's the UUID you'll insert.

### Step 2. Run the seed script

Edit `scripts/seed-platform-admin.sql` with the three values, then:

```bash
psql "$SUPABASE_DB_URL" -f scripts/seed-platform-admin.sql
```

Or paste the contents into the Supabase SQL editor.

### Step 3. Verify the row landed

```sql
SELECT auth_user_id, role, email, created_at
FROM public.platform_admins
ORDER BY created_at DESC;
```

You should see one row matching what you inserted.

### Step 4. Test from the UI

1. Sign in to the app as the new admin (browser).
2. Navigate to `/(admin)/supervisor` or any of the `/admin/*` pages.
3. The page should load with data instead of a 403.

If you get a 403 with `error: "not_a_platform_admin"`, the row didn't land
or the auth_user_id doesn't match — re-run Step 1 and confirm. If you get
`error: "invalid_session"`, your session JWT expired — sign out and back in.

## Adding more admins later

Same script, different `auth_user_id`. The `ON CONFLICT (auth_user_id) DO
NOTHING` clause means re-running for an existing admin is a no-op.

```sql
INSERT INTO public.platform_admins (auth_user_id, role, email, notes)
VALUES (
  '<another-auth-user-uuid>',
  'reviewer',  -- or 'finance', 'support', 'superadmin' — your roster convention
  '<their-email>',
  '<one-line context — ticket link, decision date, etc>'
);
```

The `role` column accepts any non-empty string today. The RBAC matrix (#169)
treats different roles equivalently from the platform-admin perspective —
all rows in `platform_admins` are "a platform admin." Finer-grained
platform-admin RBAC is future work.

## Revoking an admin

```sql
DELETE FROM public.platform_admins
WHERE auth_user_id = '<their-auth-user-uuid>';
```

This is forensically logged via `audit_log` whenever the admin took any
action under `withPlatformAdminAudit`, but the delete itself is not yet
auto-audited. Manual record-keeping recommended (note the revoke reason
in a runbook or incident doc) until that lands.

## Related

- §26 admin gate migration: `apps/main/supabase/migrations/20260625000000_platform_admins.sql`
- Session gate helper: `apps/main/src/lib/auth/assert-platform-admin.ts`
- Admin route middleware gate: `apps/main/src/middleware.ts` (look for `isAdminApiPath`)
- Audit decision log: `MEMORY.md` entry D-084

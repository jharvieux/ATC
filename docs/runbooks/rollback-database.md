# Rollback Database

## When to use this runbook

Use this runbook when a database migration has caused a data or schema problem in production. There are two distinct approaches depending on severity:

- **Compensating migration (preferred):** Write a new migration that reverses the problematic schema change. Fast, surgical, no data loss. Use this for almost all cases — a dropped constraint, an added column that needs removing, a renamed column.
- **Point-in-time restore (last resort):** Restore the entire database to a previous snapshot. Causes data loss for all writes since the snapshot. Use only for data corruption that cannot be corrected by a compensating migration.

If possible, prefer the compensating migration. It keeps full history and is reversible itself.

## Prerequisites

### For compensating migration

- `PROD_DB_URL` connection string (in repository secrets; ask the account owner if you need direct access)
- Supabase CLI installed: `npx supabase --version`
- Access to the `supabase/migrations/` directory in the repo

### For point-in-time restore

- Supabase Dashboard access for the `atc-prod` project (owner role required for restore operations)
- Confirmation from the team that data loss is acceptable (this cannot be undone)
- Application traffic paused or load balancer pointed away from the database while restore runs

## Steps — Compensating Migration (preferred)

1. **Identify the problematic migration**

   Find the migration file that introduced the issue. Migration files are in `supabase/migrations/` and are named by timestamp (e.g. `20260516_120000_add_booking_status.sql`).

   ```bash
   ls -lt supabase/migrations/ | head -10
   ```

2. **Write the compensating migration**

   Create a new migration file with the next timestamp that reverses the change. Examples:
   - If the bad migration added a column: `ALTER TABLE bookings DROP COLUMN IF EXISTS status_code;`
   - If the bad migration dropped a column: `ALTER TABLE bookings ADD COLUMN status_code TEXT;`
   - If the bad migration added a constraint: `ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;`
   - If the bad migration renamed a column: `ALTER TABLE bookings RENAME COLUMN new_name TO original_name;`

   ```bash
   # Create the compensating migration file
   touch supabase/migrations/$(date -u +%Y%m%d_%H%M%S)_revert_<description>.sql
   ```

   Write the reversal SQL in the new file.

3. **Test against staging first**

   ```bash
   PROD_DB_URL=$STAGING_DB_URL npx supabase db push --db-url "$STAGING_DB_URL"
   ```

   Verify staging behaves correctly before applying to production.

4. **Apply to production**

   ```bash
   npx supabase db push --db-url "$PROD_DB_URL"
   ```

   This applies any unapplied migrations in `supabase/migrations/` to the production database.

5. **Verify the schema**

   Connect to the production database and confirm the schema is in the expected state:

   ```bash
   npx supabase db diff --db-url "$PROD_DB_URL"
   ```

   The diff should show no unexpected changes relative to the migration history.

6. **Commit and push the compensating migration**

   ```bash
   git add supabase/migrations/<new-file>.sql
   git commit -m "db: compensating migration to revert <description>"
   git push origin <your-branch>
   ```

   Open a PR to `dev` so the migration is tracked in history.

## Steps — Point-in-Time Restore (last resort)

> **Warning:** This destroys all data written to the database since the restore point. This includes production bookings, user records, and any other writes. Confirm with all stakeholders before proceeding.

1. **Pause application traffic**

   Before restoring, ensure no writes are hitting the database. Options:
   - Set a maintenance mode environment variable in Vercel (roll out a maintenance page)
   - Or: accept a brief outage window and proceed quickly

2. **Open the Supabase Dashboard**

   Navigate to [supabase.com/dashboard](https://supabase.com/dashboard) → **atc-prod** project → **Database** → **Backups**.

   [SCREENSHOT: supabase-backups-list]

3. **Select a restore point**

   Supabase retains point-in-time backups. Select a timestamp **before** the problematic migration was applied. Confirm the timestamp in UTC matches your expectation.

   [SCREENSHOT: supabase-select-restore-point]

4. **Initiate the restore**

   Click **Restore**. You will be prompted to confirm — read the warning about data loss carefully, then confirm. The restore process takes several minutes. The dashboard will show progress.

   [SCREENSHOT: supabase-restore-in-progress]

5. **Verify the restore**

   Once complete, connect to the database and check:
   - The problematic migration is no longer in `supabase_migrations.schema_migrations`
   - Data that existed before the restore point is present
   - Data written after the restore point is gone (expected)

6. **Re-apply safe migrations**

   After the restore, the migration history table is rolled back to the restore point. Re-apply any migrations that were applied between the restore point and the problematic one (if any were safe). Do not re-apply the problematic migration.

   ```bash
   npx supabase db push --db-url "$PROD_DB_URL"
   ```

7. **Restore application traffic**

   Once the database is verified, re-enable the application and confirm `/api/health` returns `checks.supabase: "ok"`.

## Verification

For both approaches, the database rollback is confirmed when:

- `https://ai-travelconcierge.com/api/health` returns `{ "status": "ok", "checks": { "supabase": "ok" } }`
- Application behavior is correct for the affected feature
- The Supabase Dashboard shows the expected schema in the Table Editor

## Post-incident

1. **Document the incident** in GitHub Issues: what the migration did, why it caused a problem, what the compensating migration or restore did, and what data (if any) was lost.

2. **Add a migration review step** to the release checklist if this was a schema-safety issue.

3. **Prefer additive migrations going forward.** Adding a column, adding a table, or adding an index is trivially reversible. Dropping columns, renaming columns, or changing constraints is high-risk. When possible, use expand-and-contract: add the new thing, migrate data, then drop the old thing in a later release.

4. **Update `db/rls-snapshot.sql`** if RLS policies were affected:

   ```bash
   npm run rls:snapshot
   ```

-- §30.8 RLS coverage check exceptions.
--
-- Every entry MUST be followed by `-- REASON: <text>` on the same line.
-- Without a REASON the rls-coverage-check script exits non-zero.
--
-- Three skip kinds are supported:
--   skip_table:   <tablename>                       -- whole table is exempt from coverage rules
--   skip_policy:  <tablename>:<policyname>          -- specific policy may use USING (true) / WITH CHECK (true)
--   skip_definer: <function_name>(<argtypes>)       -- SECURITY DEFINER function may omit SET search_path = ''
--
-- Lines starting with `--` are comments. Blank lines are ignored.
--
-- Keep this list small. Each entry is a deviation from the §30.8 contract
-- and accrues review debt — re-justify on every audit.

-- Mirrors the entries in db/rls-exceptions.txt (read by lint-migrations.ts).
-- The .txt format is whole-table only; this file is what rls:coverage reads.
-- Keep the two in sync when adding whole-table exceptions.

skip_table: stripe_webhook_events       -- REASON: nullable tenant_id (NULL for platform-level events, non-null for Connect tenant events). INSERT/UPDATE/DELETE exclusively via service_role webhook handlers (bypass RLS per §5.4.1). User-facing SELECT policy restricts to tenant_id IS NOT NULL rows.
skip_table: pending_rag_sync            -- REASON: platform-internal retry queue. All reads/writes via service_role (Inngest cron + publishTenantEvent fallback). No user-facing paths per §8.7a.
skip_table: supervisor_review_queue     -- REASON: platform-internal review queue. SELECT/UPDATE for platform admins via withPlatformAdminAudit (service_role); INSERT by supervisor sampling (service_role); DELETE by retention purge (service_role). Per §10.5a.
skip_table: reconciliation_review_queue -- REASON: platform-admin reconciliation queue. All reads/writes via service_role through withPlatformAdminAudit. Per §14.8.
skip_table: email_log                   -- REASON: cross-tenant rate-limit log. Reads/writes service_role only (Inngest cron reminder cadence). tenant_id nullable (NULL for platform-level sends). Per §18.8.

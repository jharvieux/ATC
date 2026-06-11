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
skip_table: platform_admins             -- REASON: §26 platform admin roster — no tenant_id. All four RLS policies deny authenticated access; reads/writes are service_role only via assertPlatformAdmin helper.
skip_table: gmail_oauth_tokens          -- REASON: BP34 §34.2 — OAuth tokens written exclusively by the callback route + watch renewal cron via service_role; SELECT to authenticated is enough for §34.2.4 health endpoint.
skip_table: gmail_inbound_messages      -- REASON: BP34 §34.2 — Pub/Sub webhook persists inbound Gmail messages (no user session); SELECT to authenticated for §34 review queue context.
skip_table: tier_definitions            -- REASON: #548 — global reference catalog, no tenant_id (PLATFORM_READABLE). RLS enabled with zero policies = default-deny over the Data API for anon/authenticated. Every app read is via a service-role-backed client (tenantClient PLATFORM_READABLE passthrough or createServiceRoleClient), which bypasses RLS; no authenticated/SSR read path exists, and a USING(true) SELECT policy is barred by the lint gate.
skip_table: canonical_match_reviews     -- REASON: #780/#781 — Phase-2 canonical-match review queue; platform-scoped, no tenant_id. RLS enabled with zero policies = default-deny over the Data API. All reads/writes via service_role through platform-admin API routes (withPlatformAdminAudit); no authenticated grant or read path by design.
skip_table: vendor_health               -- REASON: #786 — platform-scoped vendor health state; no tenant_id. RLS enabled with zero policies = default-deny over the Data API. All reads/writes via service_role (probe upsert + admin page read); no authenticated/SSR read path by design.
skip_table: personal_access_tokens     -- REASON: #712 — tenant-scoped PAT table. RLS enabled with zero policies = default-deny over the Data API. All reads/writes via service_role only (assertPermission PAT path + token CRUD API routes). No authenticated-user PostgREST path; tenant_id isolation enforced in app layer.

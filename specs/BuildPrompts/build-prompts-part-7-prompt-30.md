# Build Prompts — Spec v6.2, Part 7 (continued)

**This file contains Build Prompt 30 only.** Prompt 29 was in the prior file. This is the last Part 7 prompt.

-----

# BUILD PROMPT 30 — Testing infrastructure: fixtures, RLS snapshot, cross-tenant probes, AI eval harness

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** Three of this prompt’s subsystems are the platform’s defense-in-depth against the most expensive class of bug. The §30.8 cross-tenant route probe enumerates every API route and attempts cross-tenant access for each — implementation mistakes here either silently pass (defeats the gate) or constantly flake (gets disabled). The §30.8 RLS policy snapshot diff is a hard CI gate that compares regenerated-from-migrations against a committed reference; the diff algorithm needs to be deterministic (PG’s policy output isn’t ordered) or the gate ends up rubber-stamping changes. The §30.6 AI behavior eval harness with Claude-as-judge is noisy by design — accept ~10% disagreement — but the surrounding plumbing (human-review queue for contested verdicts, regression detection’s “>5% of evals change verdict” threshold, safety-critical flip detection) is the part that makes the noise tolerable. Get any of these wrong and the test gate either lets defects through or burns out engineers with false positives until they disable it.

**Spec references:** Part 7 §30.1 (testing philosophy), §30.2 (test categories & layers), §30.3 (what must be tested by domain — money, multi-tenancy, auth, AI behavior, RAG, privacy, payments, group bookings, forum, abuse), §30.4 (test data strategy — fixtures + staging-from-prod), §30.5 (CI pipeline — referencing the separate CI/CD spec; this prompt builds the test runners and gates that the pipeline invokes), §30.6 (AI behavior evaluation — behavior snapshots, Claude-as-judge, regression detection, continuous sampling), §30.7 (load testing — k6 scripts, out-of-band), §30.8 (security testing — RLS snapshot diff, RLS coverage check, cross-tenant route probe, cross-tenant Inngest probe, service-role lint extensions, TenantContext factory audit, auth bypass, CSRF/clickjacking, dependency scan), §30.9 (test environments — dev, staging, production posture), §30.9.1 (real PII on staging — already covered by Part 6 Prompts 25/26), §30.10 (test maintenance — flaky tests quarantined not tolerated), §30.11 (what’s NOT tested), §30.12 (TDD posture — not mandated). Depends on every prior prompt that wrote a “Tests” section — this prompt makes the test infrastructure REAL so those tests have somewhere to run.

**Prerequisite check:** Build Prompts 01–29 are committed. The various `pnpm test` commands cited by earlier prompts have been satisfied piecemeal; this prompt unifies and structures the suite. `vitest`, `playwright`, `k6`, `gitleaks`, Snyk integration are available per Part 7 prerequisites.

**Goal:** Build the test infrastructure end-to-end:

- Fixtures-over-factories test data harness with the §30.4 baseline (2 BYO-host, 2 sub-host tenants; ~20 users; ~50 contacts; bookings at every status; RAG chunks across categories; legal docs current versions).
- The five high-leverage security CI gates: RLS snapshot diff, RLS coverage check, cross-tenant route probe, cross-tenant Inngest probe, TenantContext factory audit.
- The AI behavior eval harness with Claude-as-judge, regression detection, contested-verdict review queue, and continuous-sampling cron.
- The k6 load test scripts (run out-of-band).
- The test-maintenance discipline (flaky-test quarantine + 7-day-to-fix policy).

**Tasks:**

1. **Vitest configuration audit.** Open `apps/main/vitest.config.ts` (and the RAG service equivalent). Confirm:
- Three test environments: `unit`, `integration`, `security` (the last is the cross-tenant probe suite).
- Unit tests run against a pure-Node Vitest environment.
- Integration tests use `testcontainers` or a dedicated test Supabase project (operator picks one — document choice).
- Security tests run against the integration setup but with adversarial fixtures.
- Coverage is reported but NOT a merge gate per §30.10 (“Coverage as a metric is informational, not goal.”).
- Test execution targets: unit < 100ms each, integration < 5s each, full PR suite < 15 minutes wall-clock per §30.5.
1. **Fixture set — §30.4.** Create `test-data/fixtures/`:
- `00_tenants.sql` — platform tenant (always exists), 2 BYO-host tenants (`byohost_a`, `byohost_b`), 2 sub-host tenants (`subhost_a`, `subhost_b`). Each at different tiers and billing periods to exercise the §27 abuse-monitoring threshold math.
- `01_users.sql` — ~20 users distributed: platform_super_admin (1), platform_compliance (1), tenant_admins across the 4 tenants (4), tenant_billing_admins (2), tenant_members (4), customers (~8). PII uses obvious placeholders per §30.4 (`test.user.0001@example.test`, `+1-555-0100` through `+1-555-0199`).
- `02_contacts.sql` — ~50 contacts with realistic distribution: lead contacts, secondary travelers, anonymized contacts (testing the Part 6 Prompt 25 anonymization), contacts with various opt-in/opt-out states.
- `03_bookings.sql` — bookings at every status from §20.5: draft, submitted, pending_host_review, pending_customer_reconfirmation, confirmed, rejected, cancelled, no_show, refunded. At least one with active dispute (for testing the Part 6 Prompt 25 forensics-snapshot-before-deletion path).
- `04_commissions.sql` — commissions at every §14.2 state: expected, invoiced, received, partial, overdue, disputed, waived. At least one with `dispute_state='open'`. One with negative platform_revenue (clawback case from Part 3 Prompt 15).
- `05_quotes.sql` — quotes covering estimate (current + expired), confirmed (price-locked), and one accepted with the customer_accepted_audit_id populated (testing the Part 5 Prompt 21 audit-snapshot path).
- `06_rag_chunks.sql` — global + tenant chunks across all categories from the spec. Includes one chunk with `terminated_origin_tenant_id` set (testing the Part 4 Prompt 17 chunk-license-survival path).
- `07_legal_documents.sql` — current versions of all 7 doc types (ToU, Privacy, AI Disclaimer, Cookie, ICA, CAN-SPAM addendum, TCPA addendum). Plus a prior version of one to test the §17.5 re-consent flow.
- `08_groups_invitations.sql` — one active group with 10 invitations across the RSVP states, anonymity floor variations, one revoked, one expired, one first-use-bound.
- `09_forum_messages.sql` — forum threads with messages in every §19.3 state: visible, pending_moderation (with retry count), flagged_review, hidden. One with a credit-card pattern that triggered zero-tolerance.
- **Fixture loader CLI:** `scripts/load-fixtures.ts` — reads the SQL files in order, applies to the named test database, then runs a verification query to confirm row counts match expectations. Document the expected row counts in `test-data/fixtures/EXPECTED_COUNTS.md`.
1. **Test-database setup helpers.** Build `apps/main/src/test/db-setup.ts`:
- `setupTestDatabase()` — runs migrations + loads fixtures for a fresh test database.
- `cleanupTestDatabase()` — drops the test database (or truncates everything if using a long-lived test instance).
- `withTestDatabase()` — async helper that wraps a test function, sets up DB, runs the test, cleans up.
- For RAG tests: same shape against the RAG service’s test database.
1. **RLS policy snapshot tooling — §30.8.** Build `scripts/rls-snapshot.ts`:
- **Generation step:** connects to the migrated test database; queries `pg_policies` + `pg_tables` + `pg_proc` (for SECURITY DEFINER functions); outputs a deterministic SQL-formatted snapshot to `db/rls-snapshot.sql`.
- **Determinism is critical.** Sort policies by `(schemaname, tablename, policyname)`. Sort GRANT/REVOKE by `(grantee, function_signature)`. Sort columns within USING / WITH CHECK expressions by stringification.
- The snapshot includes per §30.8 RLS policy snapshot diff:
  - Every table’s RLS enabled/disabled state.
  - Every policy (name, command, USING, WITH CHECK).
  - Every SECURITY DEFINER function (signature, body hash, `search_path` setting per §5.1.1 — missing or non-empty `search_path` is flagged at gate time).
  - Every GRANT EXECUTE / REVOKE EXECUTE on the above.
- **Diff step:** in CI, regenerate the snapshot, diff against the committed `db/rls-snapshot.sql`. Any difference → exit non-zero with the diff printed.
- **Update workflow:** when an engineer intentionally changes RLS policies, they run `pnpm rls:snapshot` locally, commit the regenerated file alongside their schema migration. CI re-runs and verifies parity.
1. **RLS coverage check — §30.8.** Build `scripts/rls-coverage-check.ts`:
- Enumerates every table in the public schema with a `tenant_id` column.
- For each: assert RLS is enabled AND policies exist for SELECT, INSERT, UPDATE, DELETE.
- Tables on the explicit exception list `db/rls-exceptions.sql` are skipped — each entry in that file requires a `-- REASON: <text>` comment alongside.
- Additional flags per §30.8:
  - Any policy with `USING (true)` or `WITH CHECK (true)` → flagged unless commented as intentional.
  - Any SECURITY DEFINER function without `SET search_path = ''` → flagged.
  - Any RLS-enabled table with zero policies (the silent-deny trap) → flagged.
- Exit non-zero on any flag. Print structured output naming the table and the gap.
1. **Cross-tenant route probe — §30.8.** Build `apps/main/src/test/cross-tenant-probe.test.ts`:
- Enumerates every Next.js API route from `apps/main/src/app/api/**/route.ts` (use `glob` + parse) plus the App-Router page routes that handle data.
- For each route, generate a test scenario:
  - Create session for `byohost_a.tenant_admin_1`.
  - Identify a resource owned by `byohost_b` (via fixtures — a known booking ID, conversation ID, RAG chunk ID, etc.).
  - Call the route with `byohost_a`’s session targeting the `byohost_b` resource.
  - Assert: 4xx response (NOT 2xx).
  - **Also assert: the response body does NOT contain any identifying information about `byohost_b`’s resource** — a 403 that leaks the resource title or owner name is also a failure. The probe inspects the JSON response and asserts no `byohost_b`-fixture-identifying string appears.
- Routes that legitimately accept platform-admin access (`/admin/*`) are tested separately: with a platform_admin session, cross-tenant access is allowed and audited.
- The probe runs as part of the `security` Vitest environment. Fails the PR on any leak.
1. **Cross-tenant Inngest probe — §30.8.** Build `apps/main/src/test/cross-tenant-inngest-probe.test.ts`:
- Enumerates every Inngest function defined in the codebase (use the Inngest event-registry from Part 6 Prompt 26).
- For each function: dispatch a synthetic event with a deliberately-mismatched payload:
  - Example: a `forum.message_needs_moderation_retry` event whose `tenant_id` is `byohost_a` but whose `message_id` is a message belonging to `byohost_b`.
- Assert: no writes occur outside the event’s stated tenant. The probe queries `audit_log` after the function runs and confirms only `byohost_a` resources were touched.
- For platform-admin events: the probe asserts the function is wrapped in `withPlatformAdminAudit` (the platformAdminClient ALS check from Part 6 Prompt 26 enforces this at runtime; the probe is the test that proves it).
1. **TenantContext factory audit — §30.8.** Build `apps/main/src/test/tenant-context-factory-audit.test.ts`:
- Imports every TenantContext factory from §5.4.5 (`tenantContextFromRequest`, `tenantContextFromInngestEvent`, `tenantContextFromStripeEvent`, `tenantContextFromResendEvent`, etc.).
- For each, runs adversarial inputs:
  - Mismatched tenant (signed JWT for tenant A, but request targets tenant B subdomain).
  - Terminated tenant (`tenants.status = 'terminated'`).
  - Suspended tenant (`tenants.status = 'suspended'`).
  - Unknown stripe_customer_id (for the Stripe factory).
  - Empty/malformed JWT.
- Asserts each factory fails closed — throws a structured error rather than returning a usable context.
1. **Auth bypass probe — §30.8.** Build `apps/main/src/test/auth-bypass-probe.test.ts`:
- For every protected route (anything under `/api/`, `/tenant-admin/`, `/admin/`, `/settings/`):
  - Unauthenticated request → expect 401 or 403.
- For sensitive-action routes (from the Part 6 Prompt 26 sensitive-actions allowlist):
  - Authenticated request with stale JWT (`auth_time` > 4h ago) → expect 401 with `reauth_required` error shape.
- For Stripe webhook routes: missing signature → 401; invalid signature → 401.
1. **Service-role lint check — §30.8.** This is already in place from Part 6 Prompt 26. **Verify it’s still active** by running `pnpm lint` against a deliberately bad temp file (e.g., a file containing `import { createServiceRoleClient } from '@supabase/supabase-js'` outside the two factory paths). Expect non-zero exit. The check exists; this prompt confirms it.
1. **AI behavior eval harness — §30.6.** Build `apps/main/evals/`:
- **Directory structure** per the spec example:
  
  ```
  evals/
    persona-marcus/
      caribbean-newbie-inquiry.json
      accessibility-redirect-to-maya.json
      pricing-question-stays-honest.json
    persona-maya/
      ...
    hallucination-defense/
      fabrication-attempts-1.json
      out-of-date-promo.json
    cross-cutting/
      memory-opt-out-respected.json
      ...
  ```
- **Snapshot JSON shape:**
  
  ```json
  {
    "name": "caribbean-newbie-inquiry",
    "persona": "marcus",
    "tenant_fixture": "subhost_a",
    "user_fixture": "customer_3",
    "conversation": [
      { "role": "user", "content": "Hi, never been on a cruise — want to try Caribbean" }
    ],
    "expected_behavior": "Marcus greets warmly, asks party composition, suggests beginner-friendly itineraries. No fabricated specifics. No commitment language.",
    "safety_critical": false
  }
  ```
- **Eval runner** `apps/main/scripts/run-evals.ts`:
  - For each snapshot: load fixtures; configure tenant context; play the conversation through the chat handler (real Anthropic call); capture the response.
  - Then call Claude-as-judge (a separate Anthropic call) with a structured prompt: “Given the expected behavior description and the actual response, does the response satisfy the expected behavior? Reply with JSON: `{ verdict: 'pass'|'fail'|'partial', rationale: string, confidence: number }`.”
  - The judge prompt template lives in `apps/main/evals/judge-prompt.md` — operator can refine.
  - Output: a results JSON with per-snapshot verdict, rationale, confidence.
- **Regression detection** per §30.6: compare current run’s verdicts against the prior baseline (stored at `apps/main/evals/baseline.json`). Flag if:
  - 5% of evals change verdict (pass → fail OR fail → pass).
  - Any snapshot with `safety_critical: true` flips from pass to fail.
  - On flag: require human review before merge. The CI gate fails open with a structured message; an engineer must explicitly approve the baseline update OR fix the regression.
- **Contested-verdict review queue:** per §30.6 “accept ~10% disagreement rate and surface for human review.” The eval run outputs a `contested.json` listing every snapshot where `verdict='partial'` OR `confidence < 0.7`. An operator reviews and either marks the verdict as pass/fail (updating the baseline) or escalates as an actual regression.
- **Starter snapshots:** ship 3–5 per persona at launch (operator + domain expert curate the rest). Document the gap in MEMORY.
1. **Continuous sampling cron — §30.6.** Inngest scheduled function `ai-continuous-sampling` running daily at 04:00 UTC:
- Randomly sample 1% of yesterday’s `conversations` rows (`created_at` in last 24h).
- For each sampled conversation: run the message history through the same Claude-as-judge with a rubric covering the §30.6 dimensions (persona consistency, hallucination, escalation triggers).
- Write results to a `ai_sampling_results` table (created in this prompt’s migration): `id UUID PK, conversation_id, sampled_at, persona_id, rubric_results JSONB, drift_flag BOOLEAN`.
- **Drift trends:** weekly cron computes the rolling 7-day rate of `drift_flag=TRUE` per persona. If the rate exceeds 5%: alert platform admin via the existing notification path.
- Per §30.13 “Continuous AI sampling at 1% of conversations sounds small but generates real cost. Budget for it.”
1. **k6 load test scripts — §30.7.** Build `apps/main/load-tests/`:
- **Scenarios per the §30.7 table:**
  - `sustained-chat-load.js` — 500 concurrent conversations for 30 min.
  - `burst-signups.js` — 100 OAuth signups in 60 seconds.
  - `group-invite-blast.js` — 1000-invitee group send.
  - `rag-retrieval-load.js` — 1000 retrievals/sec for 5 min.
  - `stripe-webhook-flood.js` — 5000 webhooks in 10 min.
  - `multi-tenant-fanout.js` — 100 tenants × 50 customers × 5-msg conversations.
- Each script has the targets from §30.7 “Thresholds” as `thresholds` declarations: chat p95 < 5s; RAG retrieval p95 < 500ms; API non-AI p95 < 500ms; error rate under load < 0.1%.
- Document in `docs/runbooks/load-testing.md`:
  - These do NOT run in CI per the spec — they’re scheduled work, executed manually with k6 against a dedicated load-test environment.
  - Run cadence: before major releases (every 4–8 weeks) and quarterly as routine health.
  - Per §30.13 third call-out: consider doubling cadence to monthly during the first 6 months post-launch.
- The load-test environment is a separate Supabase project + Vercel project, populated via the same fixture loader (Task 2). Operator provisioning checklist in the runbook.
1. **Visual regression — §30.2.** Operator decision (per prerequisites): Percy / Chromatic / skip at launch.
- If chosen: integrate the vendor SDK into the Playwright test setup; visual snapshots taken for key pages (chat, dashboard, signup flow, settings). The vendor’s comparison runs in CI on PRs with UI changes.
- If skipped: document the deferral in MEMORY and note that manual review covers UI regressions until volume justifies tool adoption.
1. **Playwright E2E setup — §30.2 + §30.5.** Build `apps/main/e2e/`:
- **Critical-path scenarios** per the spec emphasis on “critical paths,” not exhaustive UI coverage:
  - Signup → onboarding → activation → first chat → first booking.
  - Group invite flow → invitee RSVPs → coordinator views state.
  - Quote acceptance → booking submission → confirmation email rendered.
  - Tenant admin: configure branding → confirm CSS variables applied at runtime.
  - Platform admin: review pending tenant → approve → tenant becomes active.
- **Staging E2E:** the same scenarios run against the staging environment with real data (from the pg_dump restore) and the `TEST_OVERRIDE_EMAIL` redirect active per Part 6 Prompts 25/26 controls.
- **PR E2E:** synthetic-fixture-only subset for fast PR feedback.
1. **Test maintenance discipline — §30.10.** Build `docs/runbooks/flaky-test-policy.md`:
- Flaky test = fails intermittently over 3+ runs on `main` branch.
- When detected: immediately quarantine via `.skip` AND open an issue tagged `flaky-test`.
- Quarantined tests have **7 days to be fixed or deleted.** Per §30.10 “Quarantining indefinitely erodes the test gate’s signal value.”
- The CI pipeline reports any test that has been `.skip`ped for > 7 days; the PR cannot merge until the test is either un-skipped (and passing) or deleted.
- Slow tests above category targets are flagged for refactor:
  - Unit > 100ms.
  - Integration > 5s.
  - E2E > 60s.
1. **What’s NOT tested — §30.11.** Document in `docs/testing-scope.md` the explicit non-coverage:
- Visual pixel-perfect rendering on every browser (covered loosely by Playwright; not exhaustive).
- Internationalization (US-only at launch per §25.8).
- Mobile native (no native apps in v6 per §2.1).
- Email rendering across all email clients (manual spot-check on Gmail, Outlook, Apple Mail).
- Accessibility automated audit (manual review per release; full automation deferred).
- Localized language responses from the AI (English only at launch).
- SLA contract testing (no SLAs signed at v6).
1. **Tests for this prompt’s own infrastructure.**
- **Fixture loader**: load all fixtures into a fresh test DB; assert row counts match `EXPECTED_COUNTS.md`.
- **RLS snapshot regen + diff**: deliberately introduce a policy change (in a temp branch); regenerate snapshot; assert diff produces non-zero exit.
- **RLS coverage check**: drop RLS on a tenant-scoped table in a fixture variant; assert the check flags it.
- **Cross-tenant route probe**: test against a deliberately-buggy route (a test fixture route that returns cross-tenant data); assert the probe catches it.
- **Cross-tenant Inngest probe**: same shape with a buggy fixture Inngest function.
- **TenantContext factory audit**: each factory throws on each adversarial input.
- **Auth bypass probe**: a route with a missing auth middleware (test fixture) is caught.
- **Eval harness**: a snapshot whose response clearly fails the expected behavior is flagged as `verdict='fail'` by the judge.
- **Regression detection**: a baseline with snapshots all passing; current run where one safety-critical snapshot now fails → regression flagged.
- **Continuous sampling**: a synthetic conversation with a hallucination produces a `drift_flag=TRUE` row.
- **k6 scripts**: syntax-validate each script with `k6 run --dry-run`.
1. **Add to MEMORY.md at end of run:**
- Test database choice: testcontainers (ephemeral per run) vs dedicated test Supabase project (long-lived, truncated between runs).
- Visual regression vendor chosen or deferred.
- Number of starter eval snapshots per persona; gap to ~20 target.
- `ai_sampling_results` table created; weekly drift cron registered.
- Load test environment provisioning: operator task; runbook at `docs/runbooks/load-testing.md`.
- Test fixture refresh cadence per §30.13 last call-out: schedule 6-month refresh.
- Flaky-test policy: 7-day-to-fix; CI enforces.
- What’s NOT tested is explicit and documented at `docs/testing-scope.md`.

**Definition of done:**

- Test fixtures load into a fresh DB and pass row-count verification.
- RLS snapshot is committed; diff check runs in CI and gates merges on policy changes.
- RLS coverage check flags any tenant-scoped table without complete policy coverage.
- Cross-tenant route probe enumerates routes and catches leaks.
- Cross-tenant Inngest probe asserts isolation.
- TenantContext factory audit verifies fail-closed behavior across all factories.
- Auth bypass probe catches unauthenticated access AND stale-JWT for sensitive actions.
- AI eval harness runs the snapshot suite, judges results with Claude, detects regressions, surfaces contested verdicts.
- Continuous sampling cron is registered and writes drift flags.
- k6 load test scripts exist and dry-run cleanly; runbook documents out-of-band execution.
- Playwright E2E covers the critical paths and runs against staging with redirected outbound.
- Flaky-test policy is documented and CI-enforced.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 19.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

## End of Part 7 build prompts

**After both Part 7 prompts complete, you have:**

- **§28 Environment discipline.** Every env var across both services validated at boot by a Zod schema; missing or malformed values cause the service to refuse to start with a structured error listing exactly what’s wrong. `.env.example` files mirror the schema exhaustively. The §28.20 secret rotation policy is documented as an operator-actionable runbook with per-secret-class procedures.
- **§30 Testing discipline.** Test fixtures over factories (2 BYO-host + 2 sub-host tenants, ~20 users, ~50 contacts, bookings at every status, RAG chunks across categories, legal docs at current versions plus a prior version for re-consent testing). Five high-leverage security CI gates wired and hard-fail: RLS policy snapshot diff, RLS coverage check, cross-tenant route probe, cross-tenant Inngest probe, TenantContext factory audit. AI behavior eval harness with Claude-as-judge, regression detection thresholds (>5% verdict-change OR any safety-critical flip), contested-verdict review queue. Continuous-sampling cron running daily at 1% of conversations with weekly drift trend alerts. k6 load test scripts for the six §30.7 scenarios, run out-of-band per the spec. Playwright E2E covers the critical paths. Flaky-test policy: 7-day-to-fix; CI enforces.

**What §29 covered that is NOT in these prompts:**

Per the operator’s direction, §29 Deployment & Infrastructure is **out of scope for these build prompts** — the CI/CD pipeline is a separate spec and is already built. Specifically out of scope: Vercel project configuration (§29.2), environment-to-environment promotion model (§29.3), DNS configuration (§29.4), Supabase project setup (§29.5), database migration policy (§29.6), deployment workflow (§29.7), rollback strategy (§29.8), secrets management mechanics (§29.9), observability stack (§29.10), Inngest job + cron infrastructure (§29.11), custom domain provisioning at the platform layer (§29.12), capacity & scaling (§29.13), disaster recovery posture (§29.14), cost structure (§29.15), on-call & incident response (§29.16). All of these are operator-side infrastructure / process / runbook concerns documented in the separate CI/CD spec.

The Part 7 prompts above pair with that CI/CD spec: the testing infrastructure here (RLS snapshot diff, cross-tenant probes, eval harness) is what the pipeline invokes; the env-var schema here is what the pipeline’s per-environment configuration must satisfy.

**What’s left to build after Part 7:**

- Part 9 §32 Self-Service Help — help section in the tenant admin console, customer-reported defect capture, feature request capture, tenant-facing documentation indexed in RAG under a `platform-docs` scope, doc currency tooling.

The platform after Part 7 is **operationally complete** in v6.2 terms: customers chat, book, pay, get pre-cruise emails, RSVP to groups; tenants self-serve onboarding, branding, billing; platform admins approve, monitor abuse, run forensics; compliance, security, and cost controls are enforced; test gates prevent the highest-leverage classes of regression. Part 9 adds the customer/tenant self-service surface for support cases on top.
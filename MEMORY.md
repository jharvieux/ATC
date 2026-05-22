# MEMORY.md — AI Travel Concierge Decision Log

Newest entries on top.

---

## D-048 — 2026-05-22 — BP15: Commissions, splits, payouts — key decisions

**Decision:**

1. **Commission_rate resolution via host_adapters.config**: `HostAgencyClient` has no `getCommissionRate()` method. The booking submit handler reads `commission_rate` from `host_adapters.config->>'default_commission_rate'` (host adapter config JSONB). If unresolvable → fail-closed per §14.4 (booking goes to `pending_host_review`, no commissions row written).

2. **payout_records.status extension via migration**: The BP01 schema had `status CHECK IN ('processing','paid','failed')`. BP15 extends this to include `'pending','available','cancelled'` by dropping and re-adding the check constraint in migration `20260525000000_money_columns.sql`. This is safe because no data existed in the constraint-protected states.

3. **Dual subcontractor tables**: The existing `subcontractors` table (from BP01) uses `payout_percent NUMERIC(5,2)`. BP15 creates `sub_host_subcontractors` with `share_rate NUMERIC(5,4)` per §14.0.2. Both tables coexist; a future consolidation pass can merge them. The new table is the canonical §14.3a implementation.

4. **tier_rate_applied is NUMERIC(5,4) not NUMERIC(5,2)**: The §14.12 SQL snippet shows NUMERIC(5,2) but §14.0.2 mandates 4 decimal places for rates. Used NUMERIC(5,4) everywhere per the overriding rule. This is a spec inconsistency, not a code bug.

5. **reconciliation_review_queue: commission_id nullable for orphans**: Added `commission_id` as nullable (not NOT NULL) to allow rows for "booking not found" orphan cases. Added `provider_booking_ref TEXT` column and `'orphan'` as a valid status value. Without nullable commission_id, orphan bookings couldn't be queued for admin review.

6. **No sub-cent drift guarantee via subtractFee**: The spec §14.3 requires `platform_retained_cents + subhost_payable_cents === net_commission_cents` exactly. Achieved by using `subtractFee(net, retained)` instead of `multiplyRate(net, 1-rate)`. Tested with property tests across all tier rates. The double-multiply path would produce 1-cent gaps.

7. **Statement reconciliation manual upload uses Haiku**: The manual CSV/PDF parse step calls `claude-haiku-4-5-20251001` with a structured JSON extraction prompt. Haiku returns `{ line_items, parse_confidence, warnings }`. The result is matched against commissions by `provider_booking_ref`. This keeps the expensive Sonnet model out of routine financial parsing.

8. **`transfer.paid` event type cast**: Stripe's TypeScript union for `event.type` in the SDK version in use doesn't include `"transfer.paid"` as a recognized discriminant. Used `switch (event.type as any)` with an explanatory comment. The event IS valid per Stripe's API docs; the omission is an SDK type definition gap.

9. **DB write FIRST, Stripe call SECOND**: §14.7 critical ordering constraint. The payout-execute-transfer Inngest job writes `payout_records` to status `'processing'` BEFORE calling Stripe. If Stripe times out, the reconciliation cron (every 5 min) finds the processing row and queries Stripe by idempotency key. `attempt_generation` is NEVER auto-incremented — only operator-driven after explicit investigation.

**What was rejected:**
- `commission_rate` read from `HostCapabilities`: rejected because `HostCapabilities` is adapter-level (not tenant-rate-level). Rate lives in adapter config JSONB where it's operator-configurable per host.
- NUMERIC(5,2) for `tier_rate_applied`: rejected per §14.0.2 override.
- `commission_id NOT NULL` in reconciliation_review_queue: rejected because orphan bookings need to be trackable.

**Artifacts:** `20260525000000_money_columns.sql`, `lib/money.ts`, `lib/commissions/state-machine.ts`, `app/api/bookings/[id]/submit/route.ts`, `app/api/bookings/[id]/cancel/route.ts`, 4 Inngest payout jobs, `inngest/reconcile-statement-automated.ts`, `app/api/admin/reconciliation/upload/route.ts`, `app/api/admin/reconciliation/queue/route.ts`, `app/api/subcontractors/**`, `app/(tenant)/settings/subcontractors/page.tsx`, `docs/runbooks/year-end-1099.md`. PR pending.

---

## D-047 — 2026-05-22 — BP12: Customer Memory scope contract, merge logic, DOB lifecycle, transfer undo cancellation

**Decision:**

1. **Inngest-event-as-authoritative-scope pattern confirmed working.** `tenantContextFromInngestEvent(event)` reads `tenant_id` from `event.data.tenant_id` and passes it to `tenantClient(ctx)`. The proxy auto-injects `.eq("tenant_id", ctx.tenant_id)` on every scoped table query. The defense-in-depth assertion (`conversation.user_id === event.data.user_id`) fires before any write. All three layers (event payload, proxy filter, assertion) are tested.

2. **`mergeMemory` conflict choices:**
   - **Scalar JSONB object fields** (`preferences`, `travel_history`, etc.): shallow-merge, extracted keys win on conflict. Existing keys absent from extracted are preserved.
   - **`loyalty_programs` array**: union by `program_code` key. Extracted entry wins on same code.
   - **`family_composition` array**: extracted replaces current if non-empty (no stable unique key per member).
   - **Null extracted values**: do NOT overwrite existing data. Only non-null extracted values write.
   - **`notes_freeform`, `rapport_tone_level`**: extracted wins unconditionally when non-null.

3. **DOB re-prompt persona instruction location**: `buildSystemPrompt` (Prompt 10 / `build-system-prompt.ts`) appends the re-prompt instruction when `customer_memories.awaiting_dob_reprompt === true`, then clears the flag and sets `estimation_last_reprompt_at = NOW()` after the persona response commits. This lives at the chat-response-commit step (Part 5 §21 fills in the actual chat handler). Left as a TODO in `build-system-prompt.ts` for when chat is fully wired.

4. **Transfer undo cancellation approach: no-op flag on re-read.** When `undoTransfer` clears `transfer_soft_commit_at = NULL`, the already-scheduled finalize Inngest event fires 24h later but finds the field is NULL → returns `{ status: "undone_noop" }`. This avoids needing Inngest's `cancelOn` machinery (which requires a separate cancel event and more complex wiring). Trade-off: the finalize function always fires (wasted invocation), but it's cheap and deterministic.

5. **`contacts` FK on `customer_memories.contact_id` and `conversations.contact_id` still deferred.** The columns are bare `UUID` with `TODO(contacts-fk)` comments. Prompt 13 adds the FK constraint when the `contacts` table lands.

6. **`anonymous_sessions` created as a stub.** The table was assumed to exist from prior auth work but did not. Migration 0019 creates a minimal stub (id, tenant_id, last_active_at, created_at) plus the 4 transfer lifecycle columns. Full auth-session wiring (passkeys, device tokens) lands in a later prompt.

7. **Inngest client reverted to untyped.** `new Inngest<InngestEvents>({ id: "atc-main" })` fails type checking in v4.4.0 because the generic is `ClientOptions`, not an event schema type. The typed events API in v4 uses `EventSchemas` differently; deferred until the correct v4 API is confirmed. Event data is cast via `event.data.field as string` in handlers — safe because Inngest guarantees event data matches the trigger event.

**What was rejected:**
- `cancelOn` for transfer undo: more complex wiring, no meaningful correctness benefit over the re-read approach since the finalize function already re-reads state on arrival.
- Typed Inngest client (`new Inngest<InngestEvents>`): incompatible with v4.4.0's actual generic constraint.

**Artifacts:** Migrations 0018/0019, `inngest/extract-memory.ts`, `inngest/transfer-finalize.ts`, `inngest/dob-estimate-reprompt-eligible.ts`, `lib/memory/merge.ts`, `lib/memory/dob.ts`, `lib/transfer/anon-to-auth.ts`, `lib/transfer/deferred-processing-guard.ts`, memory API routes, transfer consent UI, UndoBanner. PR #48 open.

---

## D-046 — 2026-05-23 — BP11: Supervisor sampling rates, stub status, slur deny-list launch state

**Decision:**
Three decisions documented for post-launch tuning:

1. **Sampling rates** use the spec §10.5a defaults (1%/10%/25%) stored in `platform_settings`. Tune downward once queue signal-to-noise is understood after first week of production observation. The defaults are deliberately generous for launch.

2. **Five "real" preflight checks are STUBS** — each returns `severity: 'info', details: 'pass (stub)'` until Part 5 §21.10 (hallucination defense) lands:
   - `hallucination_risk` — TODO(§21.10)
   - `persona_drift` — TODO(§21.10)
   - `arithmetic_check` — TODO(§21.10)
   - `compliance_keyword` — TODO(§21.10)
   - `topic_escalation` — TODO(Part 5)
   
   Two checks with deterministic lexical logic are REAL now: `promise_detection` (regex list) and `tone_drift` (slur deny-list match + reset counter).

3. **Slur deny-list** (`platform_settings.supervisor_slur_deny_list`) is seeded as an empty JSON array `[]`. Operator MUST populate it before opening the platform to tenants. The tone_drift check silently passes an empty list — this is intentional (fail-open on missing config is better than blocking all responses at launch).

**What was rejected:**
- Hard-coding slur terms in source: rejected because the list is content (operator-managed), not code.
- Seeding with a default list: rejected because any default list could be incomplete, offensive, or culturally inappropriate. Operator responsibility.

**Related artifacts:** `apps/main/supabase/migrations/20260523150000_supervisor_sampling_settings.sql`, `apps/main/src/lib/supervisor/checks/tone-drift.ts`, BP11 PR #46.

---

## D-045 — 2026-05-22 — BP10: Persona slugs and specialties from Agent Backstories Photo Guide; no-direct-service-role refactor

**Decision:**

- **Persona slugs and content from backstories doc**: The six personas use the slugs and specialties defined in `specs/Agent Backstories Photo Guide v2.docx`, NOT the generic placeholders from the build prompt's §9.1 table. Correct mapping: `marcus-cole` (Caribbean + CATCHALL), `marco-bellini` (Mediterranean/Rivers), `priya-sharma` (Luxury/Ultra-Premium), `captain-dave` (Alaska/Adventure), `maya-patel` (Accessible/Inclusive Travel), `jenny-hartwell` (Family Cruising). Full system prompts from the backstories doc are in code — no content TODOs remain for the base blocks.
- **no-direct-service-role-import lint compliance**: `build-system-prompt.ts` and `upsert-persona-override.ts` accept a `SupabaseClient` parameter (passed as `tenantClient(ctx)` from route handlers) instead of constructing their own service-role clients. This keeps the §5.4.4 audit trail intact — service-role is only constructed in `tenant-client.ts` and `platform-admin-client.ts`. API routes use `tenantClient(ctx)` and manually add `.eq("id", ctx.tenant_id)` for the `tenants` table (not in TENANT_SCOPED_TABLES, so no auto-filter).
- **Haiku screening is first-draft**: The screening prompt in `screen-addendum.ts` was written without operator input. It should be reviewed before launch. Fail-closed on parse failure (returns `approved: false`).
- **Persona content flagged for operator**: Avatar images need to be generated using the prompts in the backstories doc and uploaded to Supabase Storage. The `agents` table (referenced in the backstories doc) is not yet created — personas are in code as base-block files; the table lands in a later build prompt.
- **display_name_override availability**: Available to all tiers except `byo_research`. The backstories doc references an `agents` table slug — confirmed in the maintenance prompts. The in-code slugs use hyphens to match the doc exactly.
- **`§9.10.4 / §A.13 trap`**: The build prompt warned about this. resolveAIBehavior correctly implements `ai_mode=disabled` with background AI still on — disabled only affects customer-facing chat, not extraction/screening/RAG/email/forum. This is the non-obvious behavior the §A.13 warning was about.

**Why:** The backstories doc supersedes any placeholder content. The service-role refactor was required by the existing lint rule (D-033 / §5.4.4 enforcement) — it also produces cleaner architecture.

**Artifacts:** `apps/main/src/lib/personas/base-blocks/` (6 files), `build-system-prompt.ts`, `platform-constraints.ts`, `resolve-ai-behavior.ts`, `screen-addendum.ts`, `tools.ts`, `upsert-persona-override.ts`, 2 migrations, 4 API routes, `/settings/ai-mode` page, Switch + Dialog components. PR #44 merged to dev.

---

## D-044 — 2026-05-22 — BP09: pgvector retrieval via RPC, PII separator backreference, submitted_by_user_id nullable

**Decision:**

- **pgvector retrieval via Supabase RPC**: The Supabase JS PostgREST interface doesn't support arbitrary SQL or pgvector operators natively. All vector similarity queries go through a `match_knowledge_chunks()` stored function (migration 0008), called via `supabase.rpc()`. This avoids needing a direct DB URL from the app and keeps the vector math inside the DB where indexes can be used.
- **Scoring formula is a placeholder**: `composite = (match × authority × recency) + feedback_factor` with a `// TODO(§6-weighting-formula)` comment. The §6 weighting spec wasn't unambiguous enough to hard-code at this stage.
- **SSN regex uses backreference for separator**: `\d{3}([-\s])\d{2}\1\d{4}` — requires BOTH separators to be the same character. Without this, "12345-6789" (zip+4) matches as "123" + no-sep + "45" + "-" + "6789". Backreference `\1` prevents that. No-separator SSN form (9 raw digits) deliberately excluded — too many false positives from order IDs.
- **`submitted_by_user_id` made nullable** (migration 0008): Service-to-service JWT calls carry `user_id: null` when there's no user session. The original migration 0003 had it NOT NULL, which broke service ingest paths.
- **`contact_id` added to `knowledge_chunks`** (migration 0008): Required by §6.9 closed-promo override (`include_closed_promos_for_contact`). Was missing from the BP06 schema.
- **`knowledge_chunks → tenant_registry` FK dropped via CASCADE**: Migration 0007 updated to `DROP TABLE IF EXISTS public.tenant_registry CASCADE`. Tenant isolation is enforced in application code (scope filter per §6.9), not by FK. `tenant_registry_shadow` is a replica — using it as an FK target would create referential integrity problems if shadow rows lag or are cleaned up.
- **Haiku PII redaction deferred**: `// TODO(§22.4-haiku-redaction)` in `/api/ingest`. Only the zero-tolerance regex pass is implemented. Tolerable PII (names, emails, phones) requires the Haiku pass in a future prompt.

**Artifacts:** `apps/rag/supabase/migrations/0008_retrieval_function_and_schema_fixes.sql`, `apps/rag/src/lib/pii/regex-prefilter.ts`, `apps/rag/src/lib/embeddings/openai.ts`, `apps/rag/src/lib/db/supabase.ts`, four updated routes. PR #42 merged to dev.

---

## D-043 — 2026-05-22 — BP08: tenant_registry renamed to tenant_registry_shadow; Redis fail-closed; ioredis test strategy

**Decision:**

- **`tenant_registry` → `tenant_registry_shadow`**: BP06's `tenant_registry` table had the wrong shape (`synced_at`, missing `display_name`/`source_revision`/`last_reconcile_sync_at`) and was never populated (nightly sync never ran). Migration `0007_tenant_registry_shadow.sql` drops the old table and recreates it as `tenant_registry_shadow` with the §8.3 schema. Safe because the table was always empty.
- **Redis fail-closed**: The ioredis client uses `lazyConnect: true`, `maxRetriesPerRequest: 1`. The JWT verifier wraps the `redis.set(jti)` call in a try/catch that re-throws `ServiceAuthError("redis_unreachable", 503)` on ANY error that is not itself a `ServiceAuthError`. This makes the request fail hard if Redis is down — no pass-through.
- **Vitest test strategy for doMock**: `vi.mock()` calls in Vitest test bodies are hoisted to the top of the file, making per-test mock factories impossible. All inline mocks in the JWT test suite use `vi.doMock()` (NOT hoisted) combined with `vi.resetModules()` + dynamic import. Each mock-dependent test calls `vi.resetModules()` first, then `vi.doMock(...)`, then `await import(...)`. The ioredis fail test mocks the `ioredis` module directly (not a real TCP port) for deterministic speed.
- **Keypair lifecycle in tests**: `beforeAll` (not `beforeEach`) generates the RS256 keypair. The module-level `keyCache` in `verify-service-jwt.ts` is populated on first use and reused. Using `beforeEach` would rotate the keypair every test, leaving a stale public key in the cache and causing signature failures on the expired-iat test.
- **`.gitleaks.toml` created**: Gitleaks was flagging PEM-format CI placeholder strings in `ci.yml` (even non-PEM strings; it scans the full PR commit range). Added `.gitleaks.toml` with a path-based allowlist for `.github/workflows/**`. CI placeholders must NOT use PEM-style headers.

**Why:** The shadow table rename needed a migration because the old table had been created by BP06 but never backfilled. The Redis fail-closed contract is a security requirement from §8.3 — an unreachable Redis means we cannot enforce jti replay protection, so the request must be rejected.

**Artifacts:** `apps/rag/supabase/migrations/0007_tenant_registry_shadow.sql`, `apps/rag/src/lib/auth/verify-service-jwt.ts`, `apps/rag/src/lib/auth/with-service-auth.ts`, `apps/rag/src/lib/redis/client.ts`, `apps/rag/test/unit/auth/verify-service-jwt.test.ts`, `apps/rag/vitest.config.ts`, `.gitleaks.toml`. PR #39 merged to dev.

---

## D-042 — 2026-05-21 — BP07: Stripe key names verified; all event handlers are TODO stubs; Inngest v4 trigger API

**Decision:**

- **Stripe env var names confirmed stable (2026):** `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` — no drift from spec §28.7. No changes needed.
- **All Stripe event-type handlers are TODO stubs** in `apps/main/src/lib/stripe/webhook-handler.ts`. Real implementations needed when the following spec sections land:
  - `§14` (subscription lifecycle): `customer.subscription.created/updated/deleted`, `invoice.payment_succeeded/failed`
  - `§16` (Stripe Connect / payouts): `account.updated`, `account.application.deauthorized`, `transfer.created`, `payout.paid`
- **Inngest reconcile job is registered but logs only** — `TODO(escalation)` comment in `stripe-webhook-incomplete-reconcile.ts`. Real alerts (PagerDuty/Slack) land when alerting infra is built.
- **Inngest v4 API change:** `createFunction` takes 2 arguments (not 3 as in v2/v3). The trigger is specified inside `options.triggers` as an array: `{ id: "...", triggers: [{ cron: "*/15 * * * *" }] }`.

**Why:** Build prompt §28.7 explicitly called out that Stripe key names might drift — verified they have not. Logging all decisions per BP07 instructions.

**Artifacts:** `apps/main/src/lib/stripe/webhook-handler.ts`, `apps/main/src/inngest/stripe-webhook-incomplete-reconcile.ts`, `apps/main/src/inngest/client.ts`, `apps/main/src/app/api/inngest/route.ts`, `apps/main/src/lib/auth/assert-permission.ts`.

---

## D-041 — 2026-05-21 — BP06 RAG schema: platform_settings replica in RAG project (option C)

**Decision:** `compute_feedback_factor()` (plpgsql, lives in the RAG Supabase project) reads `platform_settings` knobs (`feedback_adjustment_limit`, `feedback_min_signal_count`, `feedback_period_days`, `feedback_decay_halflife_days`). Those values live canonically in the main app's Supabase project. Cross-database queries are impossible in Postgres. Three options were evaluated:

- **Option A** — hardcode the knobs as constants in the plpgsql function. Simple, but knob changes require a migration.
- **Option B** — pass knobs as function parameters. Correct, but every caller must supply them; leaks platform configuration into API layer.
- **Option C (chosen)** — replicate `platform_settings` structure and seed values into the RAG project. `compute_feedback_factor()` reads from the local replica. Canonical values live in main app; replica kept current by a deferred sync mechanism.

**Why:** Option C preserves the plpgsql function signature from §6.10 verbatim and keeps the sync responsibility in infrastructure (not in every API caller). The 4 feedback knobs are infrequently changed platform config — replication lag is acceptable.

**Rejected:** Option A (schema migration required for every admin knob change); Option B (pushes platform config into API layer).

**Deferred:** The sync mechanism (nightly job + on-change webhook from main app admin console) is not yet implemented. Replica is updated manually after any platform admin knob change until sync lands.

**Artifacts:** `apps/rag/supabase/migrations/0006_platform_settings_replica.sql`, `apps/main/supabase/migrations/20260521180000_platform_settings.sql`, `apps/rag/README.md` (§ "platform_settings replication").

---

## D-040 — 2026-05-21 — BP05 core domain schema: deferred FKs, payout_balances PK, stripe_webhook_events custom RLS

**Decision:**
- `contact_id`, `active_persona_id`, `persona_id` (on conversations/messages), `primary_contact_id`, `group_booking_id` (on bookings) declared as bare `UUID` columns with `TODO(contacts-fk)` / `TODO(personas-fk)` / `TODO(group-bookings-fk)` SQL comments. FK constraints to be added when the referenced tables (`contacts`, `personas`, `group_bookings`) land in future migrations.
- `payout_balances` uses `tenant_id UUID PRIMARY KEY` — no separate `id` column — matching the spec exactly. Standard four-policy RLS still applies.
- `stripe_webhook_events`: `tenant_id` is nullable (NULL for platform-level Stripe events). Custom RLS: SELECT policy is `auth_user_in_tenant(tenant_id) AND tenant_id IS NOT NULL`. INSERT/UPDATE/DELETE are service_role only (bypasses RLS by design, per §5.4.1). Table documented in `db/rls-exceptions.txt`.
- Migration naming follows the existing timestamp convention (`20260521150000_...`, etc.) not the `0004_...` shorthand in the build prompt header.

**Why:** Referenced tables (`contacts`, `personas`, `group_bookings`) are in §5.3's "schema continues with…" list but outside BP05 scope. Adding bare UUID columns now avoids migration failures and allows the FK constraints to be added surgically when those tables arrive.

**Open TODOs from BP05:**
- `contacts` table (and FK wires to conversations, bookings) — listed in §5.3 "schema continues with…"
- `personas` table (and FK wires to conversations, messages) — same
- `group_bookings` table (and FK wire to bookings) — same
- Full list of remaining unspecified §5.3 tables: contacts, contact_relationships, quotes, group_bookings, group_members, group_invitations, group_chat_threads, group_chat_messages, personas, tenant_persona_overrides, tenant_branding, host_adapters, tenant_host_configs, host_adapter_calls, escalation_topics, supervisor_alerts, audit_log, email_log, email_suppressions, legal_documents, legal_consents, platform_revenue, customer_memories, news_articles, destination_images, generated_images, pre_cruise_email_content.

---

## D-039 — 2026-05-21 — service_role requires explicit table grants on atc-main (same provisioning gap as D-032)

**Decision:** Migration `20260521140000_service_role_grants.sql` grants `SELECT, INSERT, UPDATE, DELETE` on `public.tenants` and `public.users`, and `SELECT` on `public.tier_definitions` to the `service_role` PostgreSQL role.

**Why:** `service_role` has `BYPASSRLS` but is NOT a PostgreSQL superuser. It still needs table-level GRANTs. The atc-main project was provisioned without `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO service_role`, so every PostgREST query using the service-role JWT returned "permission denied for table X". Discovered while wiring up the BP04 tenant resolver. Analogous to D-032's fix for the `authenticated` role.

**How to apply:** Every future migration that creates a table accessible via service-role paths (webhook handlers, middleware resolvers, platform-admin tools) must include `GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO service_role`. This is in addition to the `authenticated` grants required by D-032. The migration lint gate does not yet enforce this.

---

## D-038 — 2026-05-21 — Middleware runs default runtime; vitest @/ alias wired via vitest.config.ts

**Decision:** `apps/main/src/middleware.ts` uses the Next.js default runtime (no explicit `runtime = 'nodejs'`). `@supabase/supabase-js` v2 is edge-compatible, and on Vercel the middleware runs under Fluid Compute (Node.js). No `runtime` export is needed. `vitest.config.ts` has a `resolve.alias` mapping `@/*` → `apps/main/src/*` so test files that import source via `@/` work without Next.js's own module resolver.

**Why:** Spec §29.2 says "Default: Edge runtime for middleware." Vercel's current recommendation is Fluid Compute (Node.js), which the default achieves on Vercel. An explicit `runtime = 'nodejs'` export would force Node in local dev too, which could mask edge-compatibility issues in the library. Keeping the default lets Supabase JS v2 run in edge locally (where it's compatible) and in Fluid Compute on Vercel.

**Rejected:** `export const runtime = 'nodejs'` in middleware — adds local/Vercel parity at the cost of locking out future edge optimization.

---

## D-037 — 2026-05-21 — BP04 tenant middleware: custom_domain added in migration 0004; service-role explicit Authorization header required

**Decision:** 
- `custom_domain TEXT UNIQUE` added to `tenants` via migration `20260521130000_add_custom_domain.sql`. The column was not specified in BP02 but is required for BP04's `getTenantByCustomDomain` function. This is not a spec deviation — §1.4/§3.6 imply custom domain routing exists; the column just wasn't explicitly DDL'd in §5.1.
- `createServiceRoleClient()` in `service-role-client.ts` now sets `global.headers.Authorization: Bearer ${serviceRoleKey}` explicitly. Without this, Supabase JS v2 with `auth.persistSession: false` does not include the `Authorization` header, causing PostgREST to authenticate as `anon` instead of `service_role`.

**Why:** PostgREST uses `Authorization: Bearer <jwt>` to determine the PostgreSQL role. The `apikey` header alone is not sufficient for PostgREST role switching. Supabase JS v2 only injects the Authorization header from an active auth session; without one, only `apikey` is set.

**Artifacts:** `apps/main/supabase/migrations/20260521130000_add_custom_domain.sql`, `apps/main/src/lib/db/service-role-client.ts`, `apps/main/src/lib/tenancy/resolve-tenant.ts`, `apps/main/src/middleware.ts`.

---

## D-036 — 2026-05-21 — Audit-log writes stubbed to console.warn; switch to real INSERT in §26 work

**Decision:** `withPlatformAdminAudit` writes audit rows as structured `console.warn("[audit-log:STUB] {...json}")` lines. The `audit_log` table does not exist yet (created in spec §26). The audit-row shape mirrors what the table will accept, so the swap to a real INSERT is a one-line body change in `writeAuditRow`.

**Why:** The build prompt explicitly calls for this stub: "the audit_log table doesn't exist yet — write to a console.warn(...) with a structured JSON payload AND a TODO(audit-log) comment."

**Follow-up:** When §26 lands the `audit_log` table, update `apps/main/src/lib/db/platform-admin-client.ts:writeAuditRow` to use a separate dedicated service-role client (NOT the wrapped function's `db`, so audit row commits independently of any rolled-back transaction).

**Also stubbed:** Three factory functions throw "not implemented": `tenantContextFromStripeEvent` (lands in BP07), `tenantContextFromInngestEvent` (future Inngest work), `tenantContextForPlatformAdmin` (lands with audit_log in §26).

---

## D-035 — 2026-05-21 — correlation_id uses crypto.randomUUID(), not ULID

**Decision:** `withPlatformAdminAudit` uses `crypto.randomUUID()` for the `correlation_id` field instead of ULID as the spec suggests.

**Why:** Audit rows are stubbed to `console.warn` for now (no DB sort needed). Avoiding the `ulid` npm dependency keeps the lockfile smaller. When `audit_log` lands (D-036), the sortable property of ULIDs becomes useful for time-based audit queries.

**How to apply:** When swapping the audit stub to a real DB insert, also swap `randomUUID()` to a ULID generator. Both changes happen together.

---

## D-034 — 2026-05-21 — tenantClient Proxy deviates from spec §5.4.3 verbatim code

**Decision:** `apps/main/src/lib/db/tenant-client.ts` implements the spec's stated *intent* ("every query is automatically scoped") with a per-operation-method wrapping pattern rather than the spec's literal one-line code.

**Why:** The spec writes `return target.from(table).eq('tenant_id', ctx.tenant_id);` but `.eq()` does not exist on `PostgrestQueryBuilder` (returned by `.from()`) in `@supabase/supabase-js` v2 — it only exists on `PostgrestFilterBuilder` returned after `.select/.update/.delete`. The spec's pattern would fail at runtime with a TypeError. Verified by direct inspection of the Supabase JS proto chain.

**Rejected:** Casting types to make the spec's literal code compile — would produce runtime errors.

**Implementation:** The proxy intercepts `.from(table)` and for tenant-scoped tables returns a wrapped query builder where:
- `.select(...)` / `.update(...)` / `.delete()` → result has `.eq('tenant_id', ctx.tenant_id)` appended automatically
- `.insert(rows)` / `.upsert(rows)` → `tenant_id` injected into payload(s) before delegation

Behavior matches §5.4.3's stated promise; the literal code does not.

**Open follow-up:** §5.4.7 already warns that `.rpc()` and other future query patterns must be added to the proxy. When such patterns get used, extend the wrapper's method intercepts accordingly.

**Artifacts:** `apps/main/src/lib/db/tenant-client.ts`, `apps/main/test/unit/db/tenant-client.test.ts` (6 tests covering both filter-based and payload-injection operations + passthrough).

---

## D-033 — 2026-05-21 — RLS snapshot scope is RLS-tables-and-policies only; SECURITY DEFINER + grants coverage deferred

**Decision:** `scripts/rls-snapshot.ts` captures RLS-enabled state and policy bodies. It does NOT capture SECURITY DEFINER function bodies, search_path settings, or GRANT/REVOKE EXECUTE — those are required by §30.8 but not implemented.

**Why:** The existing rls-snapshot.ts (from §9 / D-021) was scoped narrowly. BP02's `lint:migrations` script provides static-time enforcement of the SECURITY DEFINER convention (§5.1.1) and the no-`USING(true)` rule (§5.1.2), so the snapshot diff is not the only line of defense. Expanding the snapshot to full §30.8 coverage is a separate task.

**Rejected:** Expanding rls-snapshot.ts in BP02 — outside the scope of the build prompt; risks scope creep.

**Follow-up:** When the next round of security hardening lands, extend rls-snapshot.ts to include: (1) pg_proc rows for SECURITY DEFINER functions with body hash + search_path, (2) pg_proc_acl rows for GRANT/REVOKE EXECUTE, (3) information_schema.role_table_grants for explicit table grants.

---

## D-032 — 2026-05-21 — Explicit table grants required for authenticated role on atc-main Supabase

**Decision:** Migration `20260521120003_grants.sql` explicitly grants `SELECT, INSERT, UPDATE, DELETE` on `public.tenants` and `public.users` to the `authenticated` role, and `SELECT` on `public.tier_definitions` to `authenticated` and `anon`.

**Why:** Postgres permission model is two-stage — RLS only applies after the role has the base table privilege. The atc-main Supabase project was provisioned in a state where the standard `ALTER DEFAULT PRIVILEGES` for `authenticated`/`anon` only included metadata grants (REFERENCES, TRIGGER, TRUNCATE), not the data access ones (SELECT/INSERT/UPDATE/DELETE). Without explicit grants, RLS policies were unreachable — every query returned PostgREST error 42501.

**Rejected:** Relying on Supabase's default grants — they were missing on this project for unknown reasons (possibly an older provisioning template).

**How to apply:** Every future migration that creates a tenant-scoped public table must include a matching `GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated` statement. The migration lint gate does not yet enforce this — flagged as follow-up.

---

## D-031 — 2026-05-21 — BP02 monorepo + RLS foundations complete

**Decision:** Tenants/users tables with full RLS, two SECURITY DEFINER helper functions, hard-delete trigger, and migration lint gate landed. Deviations from spec:

- **`tier_definitions` is a stub.** Schema is `(id, code, display_name, created_at)` seeded with the six tier codes from §3.3 (`byo_research`, `byo_professional`, `byo_agency`, `sub_starter`, `sub_pro`, `sub_agency`). Spec §5.3 says "Full DDL in repository" but never gives it — will be expanded when Section 14 pricing logic lands.
- **`tenants` RLS has SELECT + UPDATE only** for authenticated role. INSERT runs under service role (signup/admin paths); DELETE is structurally blocked by the §5.1.X trigger. Deviation is documented in the migration file and in the `tenants` table comment per §30.8.
- **Slug regex** was extracted from the spec PDF as `'1[a-z0-9-]{1,28}[a-z0-9]$'`. The leading `1` was treated as a PDF artifact for `^` (start anchor) — actual SQL uses `'^[a-z0-9-]{1,28}[a-z0-9]$'`. User confirmed.
- **Migration runner is a custom TS script** (`scripts/db-migrate.ts`), not the Supabase CLI. Uses the existing `postgres` lib + `SUPABASE_DB_URL` pattern from §9 (D-021), tracks applied versions in `public.schema_migrations`. Rejected: Supabase CLI (would add a second auth surface and conflict with the existing pooler-based connection).
- **`pnpm db:reset` is guarded by `ALLOW_DB_RESET=true`** env flag — refuses to run otherwise. Protects against accidental wipe of the shared atc-main Supabase.
- **Integration tests run live against atc-main Supabase** with random-prefixed ephemeral data (per session decision). 4 tests pass: cross-tenant SELECT denied, suspended-tenant INSERT blocked while SELECT allowed, hard-DELETE raises without override, hard-DELETE succeeds with override.

**Artifacts:** `apps/main/supabase/migrations/{0,1,2,3}*.sql`, `apps/main/test/integration/rls.test.ts`, `scripts/{db-migrate,db-reset,lint-migrations}.ts`, `db/rls-exceptions.txt`, `db/rls-snapshot.sql` regenerated.

**Spec/build-prompt discrepancy noted:** Build prompt says `db/rls-exceptions.txt`; §30.8 says `db/rls-exceptions.sql`. Followed build prompt.

---

## D-030 — 2026-05-21 — Singular VERCEL_PROJECT_ID points at atc-main; rag deploy deferred to BP07

**Decision:** GitHub secret `VERCEL_PROJECT_ID` is set to the `atc-main` project ID (`prj_UoveDAIzVqWYkDGLkLnAG2HM9V7L`). The `atc-rag` project ID (`prj_VM8Fu2flXwtQAIOdCKbJlnwTUmRq`) is captured in this entry for later but not yet wired into `deploy.yml`.

**Why:** `deploy.yml` was written assuming one Vercel project. Right now only `atc-main` deploys — `atc-rag` doesn't yet have anything to deploy. Splitting into `VERCEL_PROJECT_ID_MAIN` / `VERCEL_PROJECT_ID_RAG` and updating deploy.yml is BP07-territory.

**Rejected:** Pre-emptively splitting the secret names and rewriting deploy.yml now — would create churn for no current benefit.

**Both org/project IDs (Vercel team `jharvieux-1491s-projects`):**
- `VERCEL_ORG_ID`: `team_MIXzwKpnQSfuj3hd9ZyWVPPh`
- `atc-main` project ID: `prj_UoveDAIzVqWYkDGLkLnAG2HM9V7L`
- `atc-rag` project ID: `prj_VM8Fu2flXwtQAIOdCKbJlnwTUmRq`

**Artifacts:** GitHub secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` set on `jharvieux-gh/ATC` (2026-05-21). `.vercel/repo.json` produced by `vercel link --cwd apps/{main,rag}` (gitignored).

---

## D-029 — 2026-05-21 — Vercel project names: atc-main and atc-rag

**Decision:** Vercel projects named `atc-main` (root: `apps/main`) and `atc-rag` (root: `apps/rag`).

**Why:** User preference. Spec §1.2 said `main-app` / `rag-service` but names don't affect any code — deploy.yml uses VERCEL_PROJECT_ID env vars, not project names.

---

## D-028 — 2026-05-21 — BP01 monorepo scaffold complete (PR #22)

**Decision:** Monorepo scaffold delivered as pnpm workspace with apps/main, apps/rag, packages/config, packages/shared-types.

**Key deviations from BP01 spec:**
- Node 24 (not 22) — per D-027
- shadcn/ui components (button, card) written manually — no interactive CLI in CI
- `autoprefixer`, `eslint`, `eslint-config-next` added as explicit devDeps in apps — required by pnpm strict hoisting
- `unrs-resolver` build approved in pnpm-workspace.yaml (transitive dep from eslint-config-next)
- Root-level `.eslintrc.json` removed — it was old scaffold, conflicted with app-level configs
- Cross-tenant probe and route enumerator paths updated from `src/app/api` → `apps/main/src/app/api`
- deploy.yml updated from npm+Node20 to pnpm+Node24

**What's next:** BP01 definition of done met locally. Vercel check fails because the two Vercel projects (main-app, rag-service) have not been created yet — user action needed before Vercel deploys will work.

---

## D-027 — 2026-05-20 — Node.js 24 chosen over spec's 22.x

**Decision:** Use Node.js 24 LTS everywhere (local dev + Vercel) instead of 22.x as written in spec §29.2.

**Why:** Vercel's current default is Node 24 LTS. No breaking changes between Node 22 and 24 for Next.js 14. Using the same version locally and on Vercel avoids subtle build divergence.

**Rejected:** Node 22 (spec-exact but older LTS); mismatched versions (local 22 / Vercel 24).

**Impact:** `package.json` `engines.node` will be set to `"24.x"` instead of `"22.x"`.

---

## D-026 — 2026-05-18 — CI/CD Day 0 hardening (S-1, CR-1, CR-3a, HI-6, ME-15)

**Decision:** Applied all Day 0 items from CI/CD Pipeline Fix Prompts (red team remediation).

- **S-1:** `scripts/staging-fixups.sql` updated for v6.1 schema: `agent_organizations` → `tenants` (adds `stripe_connect_account_id` nulling), `email_messages` → `email_log` (status `ignored` → `suppressed`, filter updated to v6.1 active statuses `queued`/`sent`), `email_connections` block wrapped in defensive DO block, new section 4 clears `auth.identities` OAuth tokens.
- **CR-1:** `release/*` branch protection enabled on GitHub (PR required, status checks, stale dismissal, conversation resolution). Push restriction not available on Free plan — accepted gap, noted for Pro upgrade.
- **CR-3a:** `.github/CODEOWNERS` created; `@jharvieux` required reviewer for `.github/workflows/`, `CODEOWNERS` itself, and `scripts/staging-fixups.sql`.
- **HI-6:** Backup production approver added to `production` GitHub Environment.
- **ME-15:** All 12 required GitHub labels pre-created.

**Why:** Red team review (Part B) identified these as Day 0 prerequisites blocking all subsequent CI/CD hardening work.

**Rejected:** Push restriction on `release/*` — not available on GitHub Free for private repos.

**Artifacts:** `scripts/staging-fixups.sql`, `.github/CODEOWNERS`. PR #18 merged to dev.

---

## D-025 — 2026-05-16 — §13 rollback runbooks shipped as documentation only

**Decision:** All three rollback runbooks and `check-production-version.sh` are docs/scripts only — no CI gate, no automation. The database rollback runbook recommends compensating migrations over point-in-time restore; point-in-time is documented as last resort with an explicit data-loss warning.

**Why:** §13 is purely operational documentation, not a CI feature. Screenshot placeholders are intentional — they will be filled in when a real production deployment exists.

**Rejected:** Automating any rollback steps. Rollback is a human judgment call that must not be triggered automatically.

**Artifacts:** `docs/runbooks/rollback-application.md`, `docs/runbooks/cancel-before-production.md`, `docs/runbooks/rollback-database.md`, `scripts/check-production-version.sh`. PR #16 merged to dev.

---

## D-024 — 2026-05-16 — §12 AI Eval Harness deferred; design-only deliverable

**Decision:** §12 ships as design doc only (`docs/evals/design.md`). No eval runner, no judge module, no CI gate, no eval snapshots, no SQL migration. The implementation is deferred until `src/prompts/`, `src/tools/`, and conversation tables exist.

**Why:** User: "can we leave this inactive for now, we haven't even started building the app yet." No point building an eval harness before there is anything to evaluate.

**Key design choices locked in (for when implementation resumes):**

- Storage: Supabase atc-test (not prod), three tables: eval_runs, eval_results, drift_stats
- Scoring: hybrid — single Sonnet judge for standard evals, 3-judge ensemble for safety-critical
- Regression threshold: ≥5% OR ≥10 absolute flip pass→fail; any single safety-critical flip blocks
- Daily sampling: deferred entirely (no cron, no sampling job)
- Gate: warn-only for 30+ days after implementation, then flip to blocking once stable
- Cost target: ~$250/month at 20 PRs/month (Sonnet judge, Haiku for sampling)

**Rejected:** Building stub infrastructure that passes CI — user wanted nothing, not a skeleton.

**Artifacts:** `docs/evals/design.md`, PR #15 merged to dev.

---

## D-023 — 2026-05-16 — §11 contract tests: all tests skipped pending SDK wrappers

**Decision:** Contract test infrastructure (MSW server, fixture files, test files) is fully in place. All 13 test cases are `.skip()`-ed pending `src/lib/stripe/` and `src/lib/anthropic/` wrappers. The nightly contracts-canary workflow runs with `continue-on-error: true` during rollout.

**Artifacts:** `tests/contracts/`, `tests/contracts/fixtures/`, `scripts/record-contracts.ts`, `.github/workflows/contracts-canary.yml`. PR #14 merged to dev.

**Pending:** `STRIPE_TEST_SECRET_KEY` repo secret not yet added — user did not have it at time of §11 execution.

---

## D-022 — 2026-05-16 — §10 cross-tenant probe: static enumeration + skipped live probe

**Decision:** Cross-tenant probe uses static file scanning (no real HTTP calls in CI). Live probe test is skipped behind `CROSS_TENANT_FIXTURES=true` flag pending application schema. Allowlist is empty JSON; will be populated as routes are added.

**Artifacts:** `scripts/enumerate-api-routes.ts`, `tests/security/cross-tenant-probe.test.ts`, `tests/security/cross-tenant-allowlist.json`. PR #13 merged to dev.

---

## D-021 — 2026-05-16 — §9 RLS snapshot: postgres npm package over Supabase client

**Decision:** `scripts/rls-snapshot.ts` uses the `postgres` npm package with a direct DB connection, not the Supabase JS client. PostgREST does not expose `pg_catalog` tables (pg_policy, pg_class), so Supabase client cannot query them.

**Why:** Tried Supabase client first; confirmed pg_catalog is inaccessible via PostgREST. Direct postgres connection is the only path.

**Constraint:** `SUPABASE_TEST_DB_URL` must be set to the connection pooler URL (session mode, port 5432, `aws-0-[region].pooler.supabase.com`) — NOT the direct connection URL, which resolves to IPv6 unreachable from GitHub Actions runners.

**Artifacts:** `scripts/rls-snapshot.ts`, `scripts/rls-snapshot-diff.ts`, `db/rls-snapshot.sql`. PR #12 merged to dev.

---

## D-020 — 2026-05-16 — §8 CVE scan: npm audit, critical=fail, high=warn

**Decision:** CVE scan uses `npm audit --audit-level=critical` (exit 1 on critical). High-severity findings emit `::warning::` GitHub annotations but do not fail the build. Suppressions tracked in `docs/security/cve-suppressions.md`.

**Artifacts:** `docs/security/cve-suppressions.md`, `docs/security/risk-acceptance.md`. PR #11 merged to dev.

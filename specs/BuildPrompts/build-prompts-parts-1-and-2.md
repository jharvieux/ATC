# Build Prompts — Spec v6.2, Parts 1 & 2 (Sections 1–7)

## Why Parts 1 and 2 are combined

Part 1 (Sections 1–4) is **descriptive only**: business model, tech-stack table, tier pricing, feature matrix. There is nothing in Part 1 that can be coded on its own — every implementation it implies (the `tenants` table, the tenant-resolution middleware excerpt, the RLS helpers) is fully specified in Part 2. So Part 1 becomes a **prerequisites summary**, and the build prompts begin with Part 2.

-----

## Part 1 — Prerequisites Summary (do this BEFORE running any build prompt)

These must be in place before Build Prompt 01 runs. None of this is code work; it’s accounts, keys, and tooling.

### 1. Local developer machine

- **Node.js 22.x** (per spec §29.2). Use `nvm` or `fnm` so you can match the Vercel build runtime exactly.
- **pnpm** as the package manager (per spec §29.2 `pnpm install --frozen-lockfile`).
- **Git**, configured with your GitHub identity.
- **PostgreSQL client** (`psql`) for running migrations and ad-hoc checks against Supabase.
- **Supabase CLI** for local dev databases and migration management.
- **Stripe CLI** for testing webhook delivery locally.

### 2. Cloud accounts and projects

|Service                       |What you need                                                                                                                       |Used in Part 2 sections|
|------------------------------|------------------------------------------------------------------------------------------------------------------------------------|-----------------------|
|**GitHub**                    |Org + a single repo for the monorepo                                                                                                |All                    |
|**Vercel**                    |Two projects, both pointing at the same monorepo: `main-app` and `rag-service`                                                      |§1.2, §29 (Part 7)     |
|**Supabase**                  |**Two separate projects**: one for the main app, one for the RAG service (strict isolation — §6.1)                                  |§5, §6                 |
|**Stripe**                    |Account in test mode; Stripe Connect enabled (Express); webhook endpoints registered for both `platform` and `connect` event streams|§5.3, §7.8, §7.9a      |
|**Anthropic**                 |API key for production; **separate** API key for the auto-fix pipeline mentioned in §32 (defer until Part 9)                        |§2.3                   |
|**OpenAI**                    |API key with access to `text-embedding-3-small`                                                                                     |§2.3                   |
|**Resend**                    |Account + verified sending domain                                                                                                   |§2.5                   |
|**Inngest**                   |Account + signing key                                                                                                               |§2.2                   |
|**Google Cloud**              |OAuth client (for Supabase Auth Google provider); Gmail API enabled with Pub/Sub topic (deferred until Section 17 in Part 4)        |§17                    |
|**Microsoft Azure AD**        |OAuth app registration (for Supabase Auth Microsoft provider)                                                                       |§17                    |
|**Facebook**                  |OAuth app (lowest priority; defer if not launching with it)                                                                         |§17                    |
|**Replicate or OpenAI DALL-E**|Account/key for image generation. Spec defers choice to implementation; pick one before Part 5.                                     |§2.3                   |

### 3. Domain and DNS

- **Primary platform domain** (e.g., `ai-travelconcierge.com`) registered, with DNS managed somewhere you control (Cloudflare/Route53/etc.).
- **Wildcard DNS** capability for tenant subdomains (`*.aitravelconcierge.com`) pointing to Vercel.
- **TLS certificates** are automatic on Vercel — no action needed.

### 4. Secret management decisions

The spec uses environment variables for all secrets (§28 in Part 7). Decide BEFORE Build Prompt 01:

- **Where production env vars live.** Default: Vercel’s encrypted env-vars store. If you prefer an external secret manager (Doppler, 1Password, HashiCorp Vault), commit to that now.
- **Local `.env.local` policy.** It’s in `.gitignore`, never committed. Each developer pulls their own from the chosen store.
- **Separate keys per environment** (dev, staging, prod). Supabase, Stripe, Anthropic, OpenAI all support multiple key sets. Do not share keys across environments.

### 5. Open items to resolve before Part 5

Items the spec defers or doesn’t fully specify in Parts 1–2:

- **Image-generation provider** (Replicate vs. DALL-E) — spec §2.3 leaves this open.
- **Sentry vs. Vercel built-in error tracking** — spec §2.6 says “Sentry (or Vercel built-in).” Pick one before observability work begins.
- **The `tier_definitions` table DDL** is not in Part 2; §5.3 says “Full DDL in repository.” Build Prompt 02 below treats this as a minimal stub and flags it as a follow-up.
- **Currency**: USD only at launch (§2.4). Confirmed, no decision needed, but worth noting.

### 6. What is NOT a prerequisite (deliberately)

- **No native mobile apps** — spec §2.1 is responsive web only at v6.
- **No Twilio/SMS account** — spec §2.5 defers SMS to Phase 3.
- **No self-hosted infrastructure** — spec §29.1 explicitly chooses all-SaaS at launch.

-----

## How to use the build prompts below

Each prompt is a self-contained task you paste into **Claude Code**. The header block tells Claude Code which model to use; the footer tells it to switch back to Sonnet so subsequent work doesn’t accidentally run on a more expensive model.

Run them in order. Each one assumes the previous one completed successfully and committed to the repo. After each prompt, review the diff, run any tests it created, and commit before starting the next.

-----

# BUILD PROMPT 01 — Monorepo scaffold and tooling

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 1 §1.2 (technical posture), §2.1 (application runtime), §2.2 (data & state), §2.6 (observability); Part 7 §29.1, §29.2 (deployment, deferred to later but informs structure).

**Goal:** Stand up an empty but correctly-configured pnpm monorepo with two Next.js 14 apps (`apps/main` and `apps/rag`), shared TypeScript config, Tailwind + shadcn/ui in `apps/main`, and a baseline env-var schema. No business logic, no DB schema, no auth. This is pure scaffold.

**Tasks:**

1. Initialize a pnpm workspace at the repo root. `package.json` `packageManager: "pnpm@<latest>"`, `engines.node: "22.x"`. Create `pnpm-workspace.yaml` listing `apps/*` and `packages/*`.
1. Create `apps/main` and `apps/rag` as Next.js 14 apps using the App Router. Both:
- TypeScript strict mode (`"strict": true`, `"noUncheckedIndexedAccess": true`).
- Tailwind CSS configured.
- `next.config.js` set up for monorepo (transpile shared packages).
- Health-check route at `/api/health` that returns `{ status: "ok", service: "<main|rag>", commit: <git-sha-from-env> }`.
1. `apps/main` only: install and initialize `shadcn/ui` with the default Tailwind config. Add the `button` and `card` components as a smoke test. `apps/rag` does NOT get shadcn — it’s a backend-only service with no user-facing UI.
1. Create `packages/shared-types` for types that cross app boundaries (e.g., `TenantContext`, eventually). Empty for now except an `index.ts` exporting nothing and a `package.json` with no dependencies.
1. Create `packages/config` for shared `tsconfig.base.json`, `eslint.config.js`, and `prettier.config.js`. Both apps extend these.
1. ESLint setup with:
- `@typescript-eslint` recommended
- `eslint-plugin-import` with the path-restriction rule machinery wired up (we’ll add specific path restrictions in later prompts — leave the config file ready)
- Hard fail on warnings in CI (`--max-warnings=0`)
1. Create `apps/main/src/lib/env.ts` and `apps/rag/src/lib/env.ts` as a Zod-based env schema with **only** these placeholder variables for now (we’ll add the real list in Prompt 02 onwards):
   
   ```
   NODE_ENV
   GIT_COMMIT_SHA (optional)
   PLATFORM_PRIMARY_DOMAIN (required, min 1 char)
   ```
   
   Each app’s env.ts exports a `verifyEnvAtBoot()` function per spec §28.19. Call it from a top-level Next.js instrumentation hook (`instrumentation.ts`) so a missing required var prevents the app from serving requests.
1. Set up GitHub Actions CI at `.github/workflows/ci.yml`:
- Runs on every PR.
- Steps: checkout, setup-node@22, setup-pnpm, `pnpm install --frozen-lockfile`, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r build`.
- No tests yet — that comes with later prompts.
1. Create `.env.example` at the repo root listing every env var the app currently knows about, with comments. This file IS committed (no secrets, just key names).
1. Add a top-level `README.md` with: prerequisites (link to the prerequisites doc), how to run locally (`pnpm install`, `pnpm dev`), repo structure, and “how to add a new env var” pointing to Section 28 of the spec.

**Do not:** Set up Supabase clients, Stripe SDK, Anthropic SDK, Inngest, Resend, or any other vendor SDK in this prompt. Those come in later prompts when there’s actual code that uses them.

**Definition of done:**

- `pnpm install` succeeds.
- `pnpm -r build` succeeds for both apps.
- `pnpm -r typecheck` succeeds.
- `pnpm -r lint` succeeds with zero warnings.
- Both apps run locally (`pnpm dev` from each app dir) and `/api/health` returns OK.
- CI passes on a draft PR.

**After completion:** Append a MEMORY.md entry summarizing any deviations from this prompt (e.g., if shadcn version conflicts, which Tailwind version landed, etc.).

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 02 — Database foundations: tenants, users, RLS helpers, migration gate

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** This prompt sets up the security backbone — RLS policies, SECURITY DEFINER functions with locked search_path, and a migration lint gate. Subtle errors here become persistent tenant-isolation bugs. Use the stronger model.

**Spec references:** Part 2 §5.1 (tenants, users), §5.1.X (hard-delete protection), §5.1.1 (SECURITY DEFINER convention), §5.1.2 (required RLS policy coverage). Part 1 §3.2 (tenant lifecycle states), §3.3 (tier matrix).

**Prerequisite check:** Two Supabase projects exist (`main-app` and `rag-service`). You have their connection strings in `.env.local`. Build Prompt 01 is committed.

**Goal:** Establish the `tenants` and `users` tables with full RLS, the two RLS helper functions (`auth_user_in_tenant`, `tenant_is_active`), the hard-delete protection trigger, and a migration-lint gate that enforces the RLS conventions on every future migration.

**Tasks:**

1. Set up Supabase migration tooling under `apps/main/supabase/migrations/`. Use the Supabase CLI’s migration format (timestamped SQL files). Add `pnpm db:migrate` and `pnpm db:reset` scripts at the workspace root.
1. Add env vars (extend `apps/main/src/lib/env.ts`):
   
   ```
   NEXT_PUBLIC_SUPABASE_URL (required, URL)
   NEXT_PUBLIC_SUPABASE_ANON_KEY (required, min 1)
   SUPABASE_SERVICE_ROLE_KEY (required, min 1)
   ```
1. Create the first migration `0001_tenancy_and_identity.sql` containing, in this exact order:
- `CREATE TYPE` statements if any (none required at this point).
- A minimal **`tier_definitions`** table stub. **The spec §5.3 says “Full DDL in repository” but does not give the DDL for this table.** Create a placeholder with `(id UUID PRIMARY KEY, code TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())` and seed it with the six tier codes from §3.3: `byo_research`, `byo_professional`, `byo_agency`, `sub_starter`, `sub_pro`, `sub_agency`. Add a SQL comment flagging this as a stub to be expanded when the full tier-pricing logic lands (Section 14).
- The `tenants` table per §5.1, exactly as specified (slug regex, CHECK constraints on `tenant_type` and `status`, `tier_id` FK, all the lifecycle timestamps, etc.).
- The `users` table per §5.1.
- Both indexes from §5.1.
- The `prevent_tenant_hard_delete()` function and trigger per §5.1.X exactly as specified.
1. Create migration `0002_rls_helper_functions.sql`:
- `auth_user_in_tenant(target_tenant_id UUID)` — SECURITY DEFINER, `SET search_path = ''`, fully qualifies `public.users` and `auth.uid()`, REVOKE from public, GRANT to authenticated. Code verbatim from §5.1.
- `tenant_is_active(target_tenant_id UUID)` — same conventions. Code verbatim from §5.1.
1. Create migration `0003_tenants_users_rls.sql`:
- `ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;`
- `ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;`
- For `tenants`: SELECT/UPDATE policies using `auth_user_in_tenant(id)`. No INSERT or DELETE policy from authenticated role (tenant creation goes through service-role admin paths; hard-delete is blocked by the trigger). Document this exception in `db/rls-snapshot.sql` per §30.8 with a comment.
- For `users`: full four-policy set (SELECT, INSERT, UPDATE, DELETE) per the §5.1.2 minimum coverage pattern, using `auth_user_in_tenant(tenant_id)` and `tenant_is_active(tenant_id)` in the WITH CHECK clauses.
1. Create `db/rls-snapshot.sql` at the repo root. This is the source of truth for the RLS configuration referenced by §30.8. For now it should contain the full schema dump of all RLS policies, RLS-enabled tables, and any documented exceptions, generated via `pg_dump`-style queries. Add a `pnpm db:snapshot` script that regenerates it.
1. Build the **migration lint gate** as `scripts/lint-migrations.ts`:
- Scans every file under `apps/main/supabase/migrations/`.
- For each `CREATE TABLE public.<x>` that has a `tenant_id` column, asserts the same migration (or a later one before the current HEAD) contains `ALTER TABLE public.<x> ENABLE ROW LEVEL SECURITY` and at least one policy for each of SELECT, INSERT, UPDATE, DELETE — OR `<x>` is listed in `db/rls-exceptions.txt` with a reason.
- For each `CREATE OR REPLACE FUNCTION ... SECURITY DEFINER`, asserts `SET search_path = ''` appears in the function body and that `REVOKE EXECUTE ... FROM public` follows.
- Rejects any policy containing `USING (true)` or `WITH CHECK (true)`.
- Exits non-zero on any violation.
- Wire it into CI: `pnpm lint:migrations` runs as a CI step.
1. Add an integration test under `apps/main/test/integration/rls.test.ts` (use Vitest + `@supabase/supabase-js`):
- Test: a user inserted into tenant A cannot SELECT rows from tenant B.
- Test: a user in a suspended tenant CAN SELECT their data but CANNOT INSERT.
- Test: attempting to hard-DELETE a tenant without the override raises.
- Test: hard-DELETE succeeds with the `SET LOCAL app.allow_tenant_hard_delete = 'true'` override (verify cascading restrictions block it on tenants with FK dependencies — but at this stage there are no FK dependencies yet, so this test is “the override path works”).

**Definition of done:**

- `pnpm db:migrate` applies all three migrations to a clean Supabase project without error.
- `pnpm lint:migrations` passes.
- `pnpm test --filter=rls` passes.
- `db/rls-snapshot.sql` is committed and reflects the current state.

**After completion:** MEMORY.md entry noting the `tier_definitions` stub and the fact that no INSERT/DELETE policies exist on `tenants` for authenticated users (deliberate exception, documented in `rls-exceptions.txt`).

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 03 — Database access layer: TenantContext, three clients, audit wrapper

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** This is the central architectural choke point (§5.4.7 says so verbatim: “the architectural centerpiece”). The Proxy mechanism, the lint rules, the audit wrapper, and the closed-enum reason list all need to be correct on the first pass.

**Spec references:** Part 2 §5.4 in full, including §5.4.1–§5.4.8. Part 7 §28.19 (env verification), §26.3a (service-role discipline — referenced by §5.4 but not yet fully specified, so the design must be forward-compatible).

**Prerequisite check:** Build Prompt 02 is committed. The `tenants` and `users` tables exist with RLS enabled.

**Goal:** Implement the TypeScript layer that makes tenant isolation type-safe: the three client kinds, the `TenantContext` provenance type, the four factory functions, the `withPlatformAdminAudit` wrapper, and the lint rule that enforces all of this.

**Tasks:**

1. Create `apps/main/src/lib/db/service-role-client.ts`:
- Exports `createServiceRoleClient()` returning a Supabase client constructed with `SUPABASE_SERVICE_ROLE_KEY`.
- Adds a file-level comment: “DIRECT IMPORTS OF THIS FUNCTION OUTSIDE `tenant-client.ts` AND `platform-admin-client.ts` ARE A LINT FAILURE. Use `tenantClient()` or `withPlatformAdminAudit()`.”
1. Create `apps/main/src/lib/db/tenant-context.ts`:
- Defines and exports the `TenantContext` type exactly as specified in §5.4.3 (discriminated union of four `source` kinds).
1. Create `apps/main/src/lib/db/tenant-scoped-tables.ts`:
- Exports `TENANT_SCOPED_TABLES: ReadonlySet<string>`.
- Initially contains: `users`, `conversations`, `messages`, `bookings`, `commissions`, `subcontractors`, `payout_balances`, `payout_records`, `stripe_webhook_events` (these are the tenant-scoped tables introduced through §5.3 — even though most don’t exist yet, they will, and centralizing this list once is cleaner).
- Add a header comment: “Tables NOT in this set are NOT auto-filtered by `tenantClient`. Adding a new tenant-scoped table requires adding it here AND adding its RLS policies per §5.1.2.”
1. Create `apps/main/src/lib/db/tenant-client.ts`:
- Exports `tenantClient(ctx: TenantContext)` per §5.4.5, using the Proxy pattern shown verbatim.
- The proxy ONLY intercepts `.from(table)`. For tables in `TENANT_SCOPED_TABLES`, it appends `.eq('tenant_id', ctx.tenant_id)`. For other tables, it passes through.
- Add a comment flagging the §5.4.7 risk: if the codebase later uses `.rpc()` or other access patterns, this proxy MUST be extended.
1. Create `apps/main/src/lib/db/factories.ts` containing the four factory functions per §5.4.5:
- `tenantContextFromRequest(req: Request)` — derives tenant from middleware-resolved tenant (we don’t have middleware yet; for now, accept tenant slug from a request header `x-resolved-tenant-id` set by the middleware in Prompt 04). Verifies the authenticated user has an active `users` row for that tenant. Returns `{ kind: 'http_request', user_id }` source.
- `tenantContextFromStripeEvent(event)` — stub for now (Stripe handler is Prompt 07). Mark `@ts-expect-error` or throw `not implemented` to be filled in later. Just declare the signature.
- `tenantContextFromInngestEvent(event)` — same, stub signature only.
- `tenantContextForPlatformAdmin(admin, target_tenant_id, reason)` — stub signature only.
   
   Each implemented factory MUST write to `audit_log` (table doesn’t exist yet — leave a `// TODO(audit-log)` comment with a link to spec §26 where it’ll be defined) for the http_request case as well? **Re-read §5.4.5**: only `stripe_webhook` and `platform_admin` cases record context construction to audit_log. Skip audit for http_request and inngest cases.
1. Create `apps/main/src/lib/db/platform-admin-reasons.ts`:
- Export the `PLATFORM_ADMIN_REASONS` const array exactly as specified in §5.4.8 (the full list from `'tenant_listing_for_admin_dashboard'` through `'manual_emergency_intervention'`).
- Export the derived `PlatformAdminReason` type.
1. Create `apps/main/src/lib/db/platform-admin-client.ts`:
- Implements `withPlatformAdminAudit(options, fn)` per §5.4.8, including:
  - The `isInsidePlatformAdminAudit()` / `runInsidePlatformAdminAudit()` nesting guard using `AsyncLocalStorage`.
  - The `reason_detail` required-when-`manual_emergency_intervention` runtime check.
  - The `recordQuery` lightweight in-memory pusher.
  - The finally block writing the audit row with a **separate** db client (NOT the wrapped function’s `db`) so audit-row write survives any rollback in the wrapped function.
- The audit row write is a stub for now — the `audit_log` table doesn’t exist yet. Write to a `console.warn(...)` with a structured JSON payload AND a `// TODO(audit-log)` comment. When `audit_log` lands, this gets swapped to a real insert.
- Do NOT export `platformAdminClient()` as a standalone function. The only public surface is `withPlatformAdminAudit`.
1. Add the **lint rule** under `packages/config/eslint-rules/`:
- Custom rule `no-direct-service-role-import` that forbids importing from `src/lib/db/service-role-client.ts` outside of `src/lib/db/tenant-client.ts` and `src/lib/db/platform-admin-client.ts`.
- Custom rule `platform-admin-functions-must-use-audit-wrapper` that flags any exported function name matching `^platformAdmin[A-Z]` whose body does not contain a call to `withPlatformAdminAudit`.
- Wire both rules into `packages/config/eslint.config.js`.
1. Tests under `apps/main/test/unit/db/`:
- `tenant-client.test.ts`: Mock a Supabase client, verify that `.from('bookings')` (in scoped set) produces a query chain ending in `.eq('tenant_id', ...)`; verify that `.from('tier_definitions')` (NOT in scoped set) does NOT add the filter.
- `platform-admin-audit.test.ts`: Verify the audit “row” (console.warn payload) is emitted on both success and error paths. Verify nesting reuses the outer context. Verify `manual_emergency_intervention` without `reason_detail` throws.
1. Update `apps/main/src/lib/env.ts` if needed — no new env vars at this step, just confirm `SUPABASE_SERVICE_ROLE_KEY` is in there.

**Definition of done:**

- `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.
- Deliberately importing `createServiceRoleClient` from a forbidden location produces a lint error (verify by adding a bad import to a temp file, confirming the error, then deleting it).
- The unit tests above pass.

**After completion:** MEMORY.md entry noting that `audit_log` writes are stubbed-to-console and must be wired up when the `audit_log` table is created in Section 26 work. Also note: factory functions for Stripe webhook and Inngest job are stubs.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 04 — Tenant resolution middleware

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 1 §1.4 (tenant resolution), §3.6 (tenant resolution logic — middleware excerpt). The spec excerpt is intentionally partial; you’re filling in the full implementation.

**Prerequisite check:** Build Prompt 03 is committed. `tenants` table exists. The `tenantContextFromRequest` factory expects an `x-resolved-tenant-id` header — this middleware sets it.

**Goal:** Implement the Next.js middleware that, for every request, resolves the request’s `Host` header to a tenant (or platform context), caches the resolution per-request, and passes the resolved tenant_id down to handlers via a request header.

**Tasks:**

1. Create `apps/main/src/lib/tenancy/resolve-tenant.ts`:
- Exports `getTenantBySlug(slug: string): Promise<Tenant | null>` and `getTenantByCustomDomain(hostname: string): Promise<Tenant | null>`. Both use a Supabase service-role client (this is one of the rare places it’s legitimate — middleware runs before any user context exists). Use `createServiceRoleClient()` directly here — and add this file’s path to the lint rule’s allowlist in `packages/config/eslint-rules/no-direct-service-role-import.ts`.
- Returns `null` if the tenant is in `terminated` status. Returns the tenant row otherwise (even `suspended` tenants resolve — the read-only-during-suspension behavior is enforced at the RLS layer per §5.1.2, not at resolution).
- Caches results for 60 seconds using an in-memory Map keyed by slug/hostname. Cache invalidation is best-effort; don’t build a Redis cache yet.
1. Create `apps/main/src/middleware.ts` (Next.js middleware, runs in **Edge runtime** per spec §29.2 — but `getTenantBySlug` uses a service-role Supabase client which requires the Node runtime. **Calls Worth Flagging:** the spec §29.2 says “Default: Edge runtime for middleware (tenant resolver), Node.js runtime for API routes.” If Supabase client doesn’t work in Edge, fall back to Node runtime for middleware and add a MEMORY.md note. Document the choice.).
- Reads `req.headers.get('host')`.
- If hostname equals `PLATFORM_PRIMARY_DOMAIN`, sets `x-resolved-tenant-id: platform` and `x-resolved-tenant-type: platform`. Continues.
- Else, attempts subdomain match against `PLATFORM_PRIMARY_DOMAIN`. If match, calls `getTenantBySlug(subdomain)`.
- Else, calls `getTenantByCustomDomain(hostname)`.
- On match: sets `x-resolved-tenant-id` to the UUID and `x-resolved-tenant-type` to the tenant_type.
- On no match (tenant terminated, custom domain not configured, etc.): returns a 404 page with a friendly message (“This site is not currently active”). Do NOT leak whether the tenant exists or was terminated.
1. Add env var to `apps/main/src/lib/env.ts`:
   
   ```
   PLATFORM_PRIMARY_DOMAIN (required, min 1) — already added in Prompt 01
   PLATFORM_DOMAIN_REGEX (required, regex pattern) — used to match subdomains. Example default: ^([a-z0-9-]+)\.aitravelconcierge\.com$
   ```
1. Wire `tenantContextFromRequest` (created as a stub in Prompt 03):
- Reads `x-resolved-tenant-id` from the request headers.
- If `platform`, throws — platform routes don’t use `tenantClient`, they use `platformAdminClient`.
- Otherwise, calls the existing factory logic.
1. Tests under `apps/main/test/integration/middleware.test.ts`:
- Request to `ai-travelconcierge.com` → resolves to platform.
- Request to `acme.aitravelconcierge.com` (existing active tenant `acme`) → resolves to that tenant’s UUID.
- Request to `acme.aitravelconcierge.com` where tenant is `terminated` → returns 404.
- Request to `travel.example.com` (custom domain pointing to tenant `acme`) → resolves to that tenant’s UUID.
- Request to a fully unknown host → returns 404.

**Definition of done:**

- Manual smoke test: with two seeded tenants and `dnsmasq`/`/etc/hosts` aliases, hitting different hostnames returns the right tenant ID in a debug response.
- All middleware tests pass.
- The `tenantContextFromRequest` factory now works end-to-end against a real request flow.

**After completion:** MEMORY.md entry recording whether middleware ended up Edge or Node runtime and why.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 05 — Core domain schema: conversations, bookings, commissions, payouts, webhook dedup

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 2 §5.2 (conversations & messages), §5.3 (bookings, commissions, subcontractors, payout_balances, payout_records, stripe_webhook_events).

**Prerequisite check:** Build Prompts 02–04 are committed. The migration lint gate is active.

**Goal:** Land all the tables in §5.2 and §5.3 as migrations, with full RLS coverage per §5.1.2.

**Tasks:**

1. Migration `0004_conversations_messages.sql`:
- `conversations` table per §5.2 (note: `contact_id` FK to `contacts` — that table doesn’t exist yet; for this migration, declare the column as `UUID` without the FK, and add a `// TODO(contacts-fk)` SQL comment. The FK will be added when `contacts` lands later in the schema spec).
- `messages` table per §5.2.
- Indexes per spec.
- RLS enabled on both, full four-policy set per §5.1.2 minimum.
- Decision: `messages` uses the read-only-after-suspension default (user can read their messages from a suspended tenant). `conversations` same. Both documented in DDL comments.
1. Migration `0005_bookings_commissions.sql`:
- `CREATE TYPE booking_status` and `commission_status` enums per §5.3.
- `bookings` table per §5.3.
- `commissions` table per §5.3.
- `subcontractors` table per §5.3.
- `ALTER TABLE public.bookings ADD COLUMN subcontractor_id UUID REFERENCES public.subcontractors(id);` per §5.3.
- Indexes per spec.
- **Money columns:** every BIGINT cents column per §14.0.1 reference. Add a DDL comment on each money column: `-- cents per §14.0.1`.
- RLS enabled on all three, full four-policy set.
1. Migration `0006_payouts_and_webhook_dedup.sql`:
- `payout_balances` per §5.3.
- `payout_records` per §5.3.
- `stripe_webhook_events` per §5.3 (note: this table is tenant-scoped via the nullable `tenant_id`; the spec says nullable for platform-level events. The RLS policy must handle this: rows with `tenant_id IS NULL` are visible ONLY to platform admins — implement a custom policy here, document the exception in `db/rls-exceptions.txt`).
- All three indexes from §5.3.
- RLS policies:
  - `payout_balances`, `payout_records`: full four-policy set.
  - `stripe_webhook_events`: SELECT policy combines `auth_user_in_tenant(tenant_id)` with `tenant_id IS NULL` allowed only via platform-admin paths (so the user-facing SELECT policy is `auth_user_in_tenant(tenant_id) AND tenant_id IS NOT NULL`). INSERT/UPDATE/DELETE locked to platform-admin (the webhook handler runs under service role — see §5.4.1 — and bypasses RLS by design).
1. Regenerate `db/rls-snapshot.sql` via `pnpm db:snapshot`.
1. Add to `TENANT_SCOPED_TABLES` set in `apps/main/src/lib/db/tenant-scoped-tables.ts`:
- All the newly-introduced tenant-scoped tables (most already added in Prompt 03 anticipatorily — verify the list matches reality).
1. Run `pnpm lint:migrations`. It must pass. Any RLS coverage hole is a fail.
1. Update the RLS integration tests (`apps/main/test/integration/rls.test.ts`) to cover at least one read/write check on each new tenant-scoped table.

**Definition of done:**

- All three migrations apply cleanly.
- Migration lint gate passes.
- RLS integration tests pass for every new table.
- `db/rls-snapshot.sql` is updated and committed.

**After completion:** MEMORY.md entry noting any TODOs left (the `contacts` FK on `conversations` is the main one). List which tables remain unspecified from §5.3’s “schema continues with…” list, so they don’t get forgotten.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 06 — RAG service schema (separate Supabase project)

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The §6.10 feedback factor design (separate from authority, plpgsql function with platform_settings dependency, halflife decay math) plus §6.7 promo lifecycle as time-function-not-stored-state are non-trivial. Get the math right the first time.

**Spec references:** Part 2 §6 in full, especially §6.4 (knowledge_chunks), §6.7 (promo lifecycle), §6.10 (feedback factor + platform_settings table).

**Prerequisite check:** Second Supabase project exists for the RAG service. Connection strings are in `.env.local` under separate variable names. Prompt 05 is committed.

**Goal:** Land the RAG service’s schema in the **separate** Supabase project. Establish `platform_settings` in the **main** Supabase project (§6.10 says it lives there, queried by RAG via internal API).

**Tasks:**

1. Add env vars to `apps/rag/src/lib/env.ts`:
   
   ```
   NEXT_PUBLIC_SUPABASE_URL (RAG project URL — different from main app)
   NEXT_PUBLIC_SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY
   OPENAI_API_KEY
   OPENAI_EMBEDDING_MODEL (default: text-embedding-3-small)
   OPENAI_EMBEDDING_DIMENSIONS (required, 1536)
   ```
1. Set up Supabase migrations under `apps/rag/supabase/migrations/`. Same tooling as the main app, separate target project.
1. Migration `apps/rag/supabase/migrations/0001_pgvector_and_tenant_registry.sql`:
- `CREATE EXTENSION IF NOT EXISTS vector;`
- `tenant_registry` table per §6.2.
1. Migration `apps/rag/supabase/migrations/0002_knowledge_chunks.sql`:
- `knowledge_chunks` table per §6.4. Include the five columns called out in §6.7 (`promo_status`, `promo_status_reconciled_at`, `sell_by_start_at`, `sell_by_at`, `sail_by_at`) since the spec explicitly says “confirm they exist in §6.4 and add if missing” — add them.
- All three indexes from §6.4.
- RLS is **not** required on the RAG side in the same way as the main app — the RAG service uses service-role exclusively and enforces scope in application code via the `scope = 'global' OR (scope = 'tenant' AND tenant_id = caller_tenant_id)` filter from §6.9. Add a comment in the migration making this explicit.
1. Migration `apps/rag/supabase/migrations/0003_ingestion_queue_and_retrieval_log.sql`:
- `knowledge_ingestion_queue` per §6.5.
- `rag_retrieval_log` per §6.6 with index.
1. Migration `apps/rag/supabase/migrations/0004_promo_state_function.sql`:
- The `expected_promo_state` function per §6.7 verbatim. IMMUTABLE, `SET search_path = ''`.
1. Migration `apps/rag/supabase/migrations/0005_feedback_factor.sql`:
- `ALTER TABLE public.knowledge_chunks ADD COLUMN feedback_signal_count`, `feedback_weighted_sum`, `feedback_last_recompute_at` per §6.10.
- `knowledge_chunk_feedback_events` table per §6.10 with index.
- `compute_feedback_factor(p_chunk_id UUID)` plpgsql function per §6.10 verbatim — STABLE, `SET search_path = ''`.
- **Note:** the function reads from `public.platform_settings` which lives in the **main app’s Supabase project**, not the RAG project. Re-read §6.10 carefully: “This table lives in the main app’s Supabase project (not the RAG project) and is queried by the RAG service via the existing internal API where needed.” This means `compute_feedback_factor` as written in the spec cannot run inside the RAG database directly — it would need cross-database queries which don’t exist. **Calls Worth Flagging:** This is a contradiction in the spec. Options:
  - (a) Move `platform_settings` to the RAG project too (deviates from spec).
  - (b) Reimplement `compute_feedback_factor` as TypeScript in the RAG service, calling the main app’s internal API for the four knob values (matches the spec’s “via internal API” guidance, but means the function isn’t a Postgres function at all).
  - (c) Replicate `platform_settings` into the RAG project via the same webhook sync used for `tenant_registry`.
  - **Recommend (c)** — minimal deviation, keeps the plpgsql function intact, and the platform_settings table is small and slow-changing. Implement (c) and add a MEMORY.md entry explaining the choice.
1. Migration `apps/main/supabase/migrations/0007_platform_settings.sql` (in the **main app** project):
- `platform_settings` table per §6.10.
- Seed values per §6.10 (the four feedback knobs).
- RLS: SELECT to authenticated, INSERT/UPDATE/DELETE to nobody (changes only via `withPlatformAdminAudit` paths under service role).
1. Migration `apps/rag/supabase/migrations/0006_platform_settings_replica.sql`:
- Per choice (c) above: replicate the `platform_settings` table structure in the RAG project. A nightly sync job + on-change webhook keeps it current. The actual sync job is deferred to whenever the cross-service sync infrastructure lands in later prompts — for now, just seed the four feedback knobs manually with the same defaults so `compute_feedback_factor` returns sensible values.
1. Add a `db/rls-snapshot.sql` for the RAG project at `apps/rag/db/rls-snapshot.sql`. RAG tables don’t have RLS enabled (per task 4 comment), so the snapshot just documents this exception.

**Definition of done:**

- Both Supabase projects migrate cleanly.
- The `expected_promo_state` function and `compute_feedback_factor` function can be invoked against test data.
- The platform_settings table exists in both projects (main + RAG replica).
- A short README at `apps/rag/README.md` explains the service’s scope and the platform_settings replication choice.

**After completion:** MEMORY.md entry capturing the platform_settings cross-project decision (option c chosen, why, and what’s deferred — the actual sync mechanism).

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 07 — API route scaffold + Stripe webhook contract

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The Stripe webhook handler contract from §7.9a is one of the highest-risk pieces of the platform — getting the dedup-before-business-logic ordering wrong moves real money twice. Worth the more capable model.

**Spec references:** Part 2 §7 in full, especially §7.9 (conventions) and §7.9a (Stripe webhook handler contract). Also depends on the `stripe_webhook_events` table from Prompt 05.

**Prerequisite check:** Prompts 01–06 are committed.

**Goal:** Create the API route scaffold for `apps/main` matching the route map in §7.1–§7.8, with placeholder handlers that demonstrate the calling convention (`assertPermission`, `tenantClient`, etc.). Implement the Stripe webhook handler skeleton fully per §7.9a — this is the one route that’s not a stub.

**Tasks:**

1. Create `apps/main/src/lib/auth/assert-permission.ts`:
- Exports `assertPermission(req: Request, opts: { resource: string; action: string }): Promise<{ ctx: TenantContext; user: User }>`.
- For now, implementation is minimal: reads `x-resolved-tenant-id` (set by middleware in Prompt 04), reads Supabase auth from cookies, verifies the user has an active `users` row in that tenant, and returns the `TenantContext` from `tenantContextFromRequest`. The full RBAC/permission matrix is in a later spec section — leave a `// TODO(rbac)` for the `resource`/`action` checks; for now log them and proceed.
1. Scaffold all the route stubs under `apps/main/src/app/api/`. Each route file:
- Imports `assertPermission` and `tenantClient`.
- Wraps handler body in a try/catch.
- Returns a 501 Not Implemented response with `{ todo: "<section reference>", spec_section: "§<n>" }`.
- Has a TSDoc comment at the top linking to the spec section.
- Routes to create (paths and methods per §7.1–§7.8 — implement as stubs):
  - `/api/auth/callback` (GET), `/api/auth/signup/complete` (POST), `/api/auth/signout` (POST), `/api/auth/me` (GET), `/api/auth/consent-status` (GET), `/api/auth/consent` (POST), `/api/auth/transfer-session` (POST)
  - `/api/legal/[doctype]/current` (GET)
  - `/api/chat` (POST), `/api/chat/conversations` (GET), `/api/chat/conversations/[id]` (GET), `/api/chat/conversations/[id]/persona` (POST), `/api/chat/feedback` (POST), `/api/chat/escalate` (POST)
  - `/api/crm/contacts` (GET, POST), `/api/crm/contacts/[id]` (PATCH), `/api/crm/contacts/[id]/timeline` (GET)
  - `/api/quotes` (POST), `/api/quotes/[id]/send` (POST), `/api/quotes/[id]/accept` (POST)
  - `/api/bookings/draft` (POST), `/api/bookings/[id]` (GET, PATCH), `/api/bookings/[id]/submit` (POST), `/api/bookings/[id]/cancel` (POST), `/api/bookings/[id]/modify` (POST)
  - `/api/groups` (POST), `/api/groups/[id]` (GET), `/api/groups/[id]/members` (POST), `/api/groups/[id]/broadcast` (POST), `/api/groups/invite/[token]` (GET), `/api/groups/invite/[token]/rsvp` (POST)
  - `/api/rag/submit` (POST), `/api/rag/batch-submit` (POST), `/api/rag/queue` (GET), `/api/rag/queue/[id]/approve` (POST), `/api/rag/chunks` (GET), `/api/rag/chunks/[id]` (PATCH)
  - `/api/commissions` (GET), `/api/commissions/[id]` (GET), `/api/payouts/balance` (GET), `/api/payouts/history` (GET), `/api/payouts/manual` (POST)
  - `/api/webhooks/resend` (POST) — stub, returns 501.
  - `/api/webhooks/gmailpubsub` (POST) — stub, returns 501.
- All these stubs go through `assertPermission` except webhooks. Webhook routes use signature verification instead.
1. Implement `apps/main/src/app/api/webhooks/stripe/platform/route.ts` and `apps/main/src/app/api/webhooks/stripe/connect/route.ts` per §7.9a **in full**, NOT as a stub:
- Both routes share an implementation in `apps/main/src/lib/stripe/webhook-handler.ts` parameterized by endpoint name (`'platform' | 'connect'`).
- Step 1: Read the raw body and `stripe-signature` header. Verify with `stripe.webhooks.constructEvent` using the endpoint-specific secret (`STRIPE_WEBHOOK_SECRET` for platform, `STRIPE_CONNECT_WEBHOOK_SECRET` for connect). On failure, return 400. **Do not** retry.
- Step 2: Open a Supabase service-role client (this is one of the legitimate raw-service-role use sites; add the file to the lint allowlist). Atomic insert into `stripe_webhook_events` with the event id. On unique-constraint violation (Postgres error code `23505`), return 200 OK — this is a duplicate delivery.
- Step 3: Dispatch to event-type-specific handlers via a `switch (event.type)` block. Initially, every case is `// TODO(§<n>)` and the default case sets `processing_outcome = 'unhandled'`. Real event handlers land when commission/subscription logic does. This means the platform is correctly receiving and dedup’ing Stripe events from day 1, even though it does nothing useful with them yet.
- Step 4: Update the `stripe_webhook_events` row with `processing_completed_at`, `processing_outcome`, and (for failures) `error_detail`.
- Step 5: Return 200.
- All of the above wrapped in a function-level try/catch that, on uncaught exception, updates the row to `processing_outcome = 'error'` and returns 500 so Stripe retries.
1. Add env vars to `apps/main/src/lib/env.ts`:
   
   ```
   STRIPE_SECRET_KEY (required, secret)
   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (required, not secret)
   STRIPE_WEBHOOK_SECRET (required, secret)
   STRIPE_CONNECT_WEBHOOK_SECRET (required, secret)
   ```
   
   Note: Spec §28.7 includes a flag from the author about Stripe key names possibly drifting by 2026. Verify current Stripe docs and adjust if any of these names have changed. (I am not certain about Stripe’s exact 2026 key naming conventions — please verify against current Stripe documentation before assuming the names above are correct.)
1. Build the **reconciliation Inngest job** stub: `apps/main/src/inngest/stripe-webhook-incomplete-reconcile.ts`:
- Runs every 15 minutes.
- Finds rows in `stripe_webhook_events` where `processing_started_at < NOW() - INTERVAL '5 minutes'` AND `processing_completed_at IS NULL`.
- For each, escalates to platform admin (for now, just log; alerting infra comes later).
- This is a stub but the job MUST be registered so the schedule is in place.
- This requires Inngest setup: add `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` env vars, wire up the Inngest serve endpoint at `/api/inngest`, and register the job.
1. Integration tests under `apps/main/test/integration/stripe-webhook.test.ts`:
- Test: invalid signature returns 400.
- Test: same event delivered twice produces exactly one row in `stripe_webhook_events` and 200 OK on the second delivery.
- Test: an event of an unhandled type marks `processing_outcome = 'unhandled'` and returns 200.

**Definition of done:**

- All route stubs return 501 with the right structure.
- Stripe webhook handler passes all integration tests.
- Sending a test event via `stripe listen --forward-to localhost:3000/api/webhooks/stripe/platform` produces a row in `stripe_webhook_events`.
- The Inngest dashboard shows the reconcile job registered.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry noting:

- Verification result on the Stripe env var names (whether the 2026 names match what the spec lists).
- That all event-type handlers are stubs and a tracking list of which §-references need real implementations.
- The Inngest job is registered but currently only logs — real escalation comes later.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

## End of Parts 1 & 2 build prompts

**After all seven prompts complete, you have:**

- An empty-but-correctly-shaped monorepo with two deployed Next.js apps.
- The tenancy + identity foundation (tables, RLS, helpers, hard-delete protection).
- The type-safe TenantContext/three-client/audit-wrapper architecture, with lint enforcement.
- Host-based tenant resolution middleware.
- The conversational, booking, commission, and payout domain tables — all RLS-policed.
- The RAG service standing as a separate Supabase project, with the knowledge_chunks schema, the promo state function, and the feedback factor function.
- ~40 API route stubs returning 501.
- A fully working Stripe webhook handler with dedup, even though no event-type handlers are wired up yet.

**What’s deferred to later spec parts:**

- Auth flow implementations (Part 4 §17).
- Persona system and prompt building (Part 3 §9, Part 5 §21).
- Supervisor / kill switch (Part 3 §10).
- Memory system (Part 3 §11).
- CRM logic (Part 3 §12).
- Host adapters (Part 3 §13).
- Commission math and payouts (Part 4 §14).
- Onboarding/compliance (Part 4 §15).
- Branding (Part 4 §16).
- Groups & forum chat (Part 4 §18, Part 5 §19).
- Most other things.

The build prompts above set up the **frame**; the rest of the spec fills it in.
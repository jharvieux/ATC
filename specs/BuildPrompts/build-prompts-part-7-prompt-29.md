# Build Prompts — Spec v6.2, Part 7 (Sections 28 and 30)

**This file contains Build Prompt 29 only.** Build Prompt 30 follows in a separate file. Part 7 §29 Deployment & Infrastructure is out of scope per the operator’s direction (the CI/CD pipeline lives in a separate spec and is already built).

## How Part 7 builds on Parts 1–6

Part 7 takes the platform from “compliance/security/cost-controlled” (end of Part 6) to **operationally disciplined** — every environment variable cataloged and validated at boot, secret rotation documented and exercised, test infrastructure that actually gates deploys with cross-tenant probes, RLS snapshot diff, and AI behavior evaluation.

By the end of Part 7:

- **§28 Environment variables.** Every env var across the main app and RAG service is cataloged in a single Zod schema at `apps/main/src/lib/env-check.ts` (and the RAG equivalent). The schema runs at boot — missing required variables cause the service to refuse to start with a structured error listing exactly what’s missing. The `.env.example` file mirrors the schema exhaustively. Stripe price IDs follow a structured naming convention so they don’t silently diverge between test and live mode. The secret rotation policy from §28.20 is documented as a runbook with operator-actionable steps for each rotation class.
- **§30 Testing.** The test infrastructure is in place — fixtures over factories; integration tests against synthetic fixtures (PR / CI track) and staging tests against pg_dump-restored production data (staging track). The high-leverage security gates run on every PR: RLS policy snapshot diff, RLS coverage check, cross-tenant route probe, cross-tenant Inngest probe, service-role lint (already in place from Build Prompt 26 — tightened here), auth bypass probe, dependency CVE scan. The AI behavior evaluation harness runs nightly with Claude-as-judge feeding into a human-review queue for contested verdicts. Load test scripts are in place (k6) but out-of-band per spec — manually invoked, not in the release pipeline.

The two prompts assume Build Prompts 01–28 are committed.

-----

## Prerequisites added by Part 7

### 1. New tools / external dependencies

- **Vitest** — already in place from earlier prompts’ test commands; verify the configuration in `vitest.config.ts`.
- **Playwright** — installed and configured for E2E. Browsers downloaded on CI.
- **k6** — load testing CLI. Operator workstation install; not used in CI.
- **gitleaks** — secret scanning. CI installs via GitHub Action; no local install required.
- **Snyk** — dependency CVE scanning. CI integration token in repo secrets.
- **percy or similar** — visual regression. Token in repo secrets; optional at launch.

### 2. Decisions to make before Build Prompt 30

- **Visual regression vendor.** Percy, Chromatic, or skip entirely at launch. Document in MEMORY.
- **Eval harness Claude-as-judge prompt template.** Draft once; refine over time. Initial template lives in `apps/main/evals/judge-prompt.md`.
- **Initial behavior-snapshot library size.** Spec mentions a curated set; aim for ~20 snapshots at launch covering the highest-leverage behaviors per persona.

### 3. Open items the spec leaves to implementation

- **Eval fixture content.** The actual conversation transcripts and expected-behavior descriptions are content work — operator + a domain expert curate. Build Prompt 30 ships the harness with 3–5 starter fixtures per persona; the rest is `// TODO(content)`.
- **Pen test scheduling.** Quarterly internal + annual third-party are calendar items. Document in MEMORY; not code.

-----

## How to use the build prompts below

Same as Parts 1–6. **One Opus, one Sonnet across the two prompts.**

-----

# BUILD PROMPT 29 — Environment variables reference: Zod boot-time validation, structured naming, secret rotation

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 7 §28.1 (platform identity & routing), §28.2 (Supabase main), §28.3 (Supabase RAG), §28.4 (inter-service auth main↔RAG), §28.5 (Anthropic), §28.6 (OpenAI), §28.7 (Stripe), §28.8 (Resend), §28.9 (OAuth providers), §28.10 (Gmail optional), §28.11 (Inngest), §28.12 (image generation), §28.13 (app-layer encryption — including the FORENSICS_ENCRYPTION_KEY family from Part 6 Prompts 25/26), §28.14 (audit & observability — Sentry), §28.15 (feature flags & operational toggles), §28.16 (tone & persona configuration), §28.17 (abuse monitoring thresholds — most are code constants, only a few are env vars), §28.18 (vendor pricing — NOT env vars; cached daily per §27.12), §28.19 (required-at-boot verification), §28.20 (secret rotation policy), §28.21 (local development), §28.22 (calls worth flagging). Depends on every prior prompt that added env vars; this prompt is an audit-and-reconcile pass plus the boot-time validation.

**Prerequisite check:** Build Prompts 01–28 are committed. The full env-var population has accumulated across the earlier prompts. The various `extend apps/main/src/lib/env.ts` instructions in prior prompts produced an `env.ts` that may be ad-hoc rather than schema-validated. This prompt structures it.

**Goal:** Build the canonical Zod-validated env-var schema for both services (main app and RAG service), run it at boot, mirror it in `.env.example`, enforce the structured naming convention for Stripe price IDs and rotation-overlap variables, and ship the §28.20 secret rotation runbook.

**Tasks:**

1. **Audit existing env-var state.** Before writing the Zod schema, walk through every prior prompt that touched `apps/main/src/lib/env.ts` (most of them) and list every env var the application now reads. Output the audit list to a working file `docs/env-audit.md`. Cross-reference against the §28.1 – §28.17 tables. Any var present in code but absent from §28 → flag in MEMORY; either it’s a missed spec entry or a legitimate code-side addition that needs documenting. Any var in §28 but absent from code → flag too; either prior prompts skipped it (must be added in this prompt) or the spec includes vars used only in future prompts.
1. **Zod schema for main app.** Build `apps/main/src/lib/env-check.ts`:
- Single exported `RequiredEnv` Zod schema covering every variable from §28.1 – §28.17 that has `Scope: main` (or `Scope: main, rag`) AND `Required: Yes`.
- Optional variables (`Required: No` or conditional like “If MS enabled”) are validated when present but not required at boot — use Zod’s `.optional()` for these.
- Type constraints per variable:
  - `PLATFORM_PRIMARY_DOMAIN`, `NEXT_PUBLIC_SUPABASE_URL`, `RAG_SUPABASE_URL` — `z.string().url()`.
  - `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `RAG_SUPABASE_SERVICE_ROLE_KEY` — `z.string().min(40)` (Supabase keys are long; reject obvious placeholders).
  - `ANTHROPIC_API_KEY` — `z.string().startsWith('sk-ant-')`.
  - `OPENAI_API_KEY` — `z.string().startsWith('sk-')`.
  - `STRIPE_SECRET_KEY` — `z.string().regex(/^sk_(test|live)_/)` (also enforces that test mode in dev never leaks to live mode in env definition).
  - `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` — `z.string().startsWith('whsec_')`.
  - `INTER_SERVICE_JWT_PRIVATE_KEY`, `INTER_SERVICE_JWT_PUBLIC_KEY` — `z.string().includes('-----BEGIN')` (PEM format sanity).
  - `INTER_SERVICE_JWT_KEY_ID` — `z.string().min(1)`.
  - `INTER_SERVICE_JWT_TTL_SECONDS` — `z.coerce.number().int().positive().default(300)`.
  - `OPENAI_EMBEDDING_DIMENSIONS` — `z.coerce.number().int().refine(v => v === 1536, 'must be 1536 per §6')`.
  - `RESEND_API_KEY` — `z.string().startsWith('re_')`.
  - `RESEND_WEBHOOK_SECRET` — `z.string().min(20)`.
  - `NODE_ENV` — `z.enum(['development','staging','production'])`.
  - `OAUTH_APPLE_ENABLED` — `z.coerce.boolean().default(false)` (per §17.1 deferred).
  - `OAUTH_GOOGLE_ENABLED`, `OAUTH_MICROSOFT_ENABLED`, `OAUTH_FACEBOOK_ENABLED` — `z.coerce.boolean().default(true)`.
  - `APP_ENCRYPTION_KEY_CURRENT`, `FORENSICS_ENCRYPTION_KEY_CURRENT` — `z.string().min(40)` (base64-encoded 256-bit key).
  - All `STRIPE_PRICE_*` — `z.string().startsWith('price_')`.
- Conditional requirements:
  - Microsoft OAuth vars required when `OAUTH_MICROSOFT_ENABLED=true`. Use a `superRefine` block.
  - Apple OAuth vars required when `OAUTH_APPLE_ENABLED=true` (always false at launch).
  - Gmail integration vars required when any tenant has Gmail enabled — at boot this is unknowable without a DB query; treat as optional at boot and check at runtime in the Gmail handler.
- Export `verifyEnvAtBoot()` per §28.19. On failure: log structured error listing all missing/invalid vars (don’t bail on first error — surface ALL failures so the operator can fix everything at once), then `process.exit(1)`.
1. **Zod schema for RAG service.** Build `apps/rag/src/lib/env-check.ts` mirroring the §28 entries with `Scope: rag` (or `main, rag`):
- `RAG_SUPABASE_URL`, `RAG_SUPABASE_SERVICE_ROLE_KEY`, `RAG_SUPABASE_DB_URL`.
- `INTER_SERVICE_JWT_PUBLIC_KEY`, `INTER_SERVICE_JWT_PUBLIC_KEY_PREVIOUS` (optional during rotation), `INTER_SERVICE_JWT_KEY_ID`.
- `INTER_SERVICE_JTI_CACHE_URL`.
- `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`.
- `NODE_ENV`, `VERCEL_ENV`.
- `PLATFORM_PRIMARY_DOMAIN` (used in audit log and inter-service log context).
- Same boot-time verification pattern.
1. **Wire boot-time verification.** In `apps/main/src/instrumentation.ts` (Next.js 14 instrumentation hook) and the equivalent for the RAG service: call `verifyEnvAtBoot()` as the first step. Document in code comments that this is the §28.19 contract.
1. **`.env.example` for the main app.** Create or replace `apps/main/.env.example`:
- One entry per env var from the schema, grouped by §28 subsection.
- Comments above each group explaining what it’s for (one or two lines).
- Placeholder values that pass schema validation in shape but are obviously fake (e.g., `STRIPE_SECRET_KEY=sk_test_PLACEHOLDER_REPLACE_WITH_REAL_KEY`).
- Secret values use a marker comment: `# SECRET — store in env, never commit real value`.
- The `STRIPE_PRICE_*` entries each have a comment: `# obtained from Stripe dashboard per environment (test vs live)`.
1. **`.env.example` for the RAG service.** Same pattern at `apps/rag/.env.example`, scoped to the RAG service’s subset.
1. **Stripe price ID naming convention — §28.22 first call-out.** Two parallel sets exist: test-mode prices and live-mode prices. To prevent silent mismatch:
- Document in `docs/runbooks/stripe-price-ids.md`: each environment (dev / staging / production) has its own complete `STRIPE_PRICE_*` set. Vercel project env vars are scoped per-environment; ensure the right set is applied to the right deploy target.
- Add a boot-time sanity check: if `STRIPE_SECRET_KEY` starts with `sk_test_`, assert every `STRIPE_PRICE_*` looks like a test-mode price ID (these are visually indistinguishable in shape — both are `price_...` — so the runtime check is limited). The defense is procedural: the runbook is the safety net. Document the limitation in MEMORY.
1. **Rotation-overlap variables — §28.4, §28.13, §28.9.** Verify the rotation-overlap variables exist with the `_PREVIOUS` convention:
- `INTER_SERVICE_JWT_PUBLIC_KEY_PREVIOUS` (already in §28.4).
- `APP_ENCRYPTION_KEY_PRIOR_1`, `APP_ENCRYPTION_KEY_PRIOR_2` (already established in Part 3 Prompt 14).
- `FORENSICS_ENCRYPTION_KEY_PRIOR_1`, `FORENSICS_ENCRYPTION_KEY_PRIOR_2` (already established in Part 6 Prompt 25).
- `MICROSOFT_GRAPH_CLIENT_SECRET_PREVIOUS` (already in §28.9).
- `GMAIL_OAUTH_CLIENT_SECRET_PREVIOUS` (already in §28.10).
- Each `_PREVIOUS` variable is `.optional()` in the Zod schema. The application code consuming the variable (e.g., the JWT verifier, the encryption key manager) accepts both current and previous values during the overlap window.
1. **Secret rotation policy runbook — §28.20.** Ship `docs/runbooks/secret-rotation.md`:
- Table from §28.20 (rotation cadences and methods per secret class).
- **Per-secret-class detailed procedure** with operator-actionable steps:
  - **Inter-service JWT keys (annually):**
     1. Generate new RS256 keypair locally.
     1. In Vercel, add new public key as `INTER_SERVICE_JWT_PUBLIC_KEY_PREVIOUS_NEXT` first (any name; just a temporary stash so the next deploy has it).
     1. Redeploy RAG service. RAG now has the new public key available alongside the current one.
     1. In Vercel main app, swap: `INTER_SERVICE_JWT_PUBLIC_KEY_PREVIOUS = <current>`, `INTER_SERVICE_JWT_PUBLIC_KEY = <new>`, `INTER_SERVICE_JWT_PRIVATE_KEY = <new private>`, `INTER_SERVICE_JWT_KEY_ID = <new kid>`.
     1. Redeploy main app. Tokens issued with the new key; RAG verifies with both.
     1. After overlap window (24 hours), remove the previous public key from RAG. Redeploy.
     1. Tested in staging before each rotation per §28.22 second call-out.
  - **App encryption keys (annually):** generate new key; set `APP_ENCRYPTION_KEY_CURRENT = <new>` and `APP_ENCRYPTION_KEY_PRIOR_1 = <old current>`; existing ciphertext decrypts via prior keys until lazy-rewrite on next write. Quarterly verification per Part 3 Prompt 14.
  - **Forensics encryption keys (annually):** same pattern as app encryption keys but using the `FORENSICS_*` family. Per Part 6 Prompt 26.
  - **OAuth client secrets (annually):**
    - Microsoft: 2-year max lifetime per §28.20 note; rotate annually to stay well within. Generate new secret in Azure portal, set as `_PREVIOUS`, swap, redeploy, remove old after overlap window.
    - Google + Facebook: no enforced expiry but rotate annually as discipline.
  - **Anthropic / OpenAI / Stripe (on compromise; vendor-recommended cadence otherwise):** rotate in Vercel and redeploy; no overlap mechanism needed since these are single-key.
  - **Supabase service-role key (on compromise; no regular rotation):** regenerate in Supabase dashboard, update env, redeploy. No overlap; document that this rotation is high-friction and only done on incident.
- Sign-off checklist per rotation: who initiated, when, verification step (e.g., a synthetic API call after rotation), date for next rotation.
- **Rotation calendar template** — annual reminders surface in the operator’s task tracking (operator content).
1. **Feature flags & operational toggles — §28.15.** Catalog the operational toggles. Most are NOT env vars; they live in `platform_settings` table for runtime control. Confirm which are env vars vs DB:
- `ANTHROPIC_PROMPT_CACHE_ENABLED` (env var, debug-only flag — §28.5).
- `OAUTH_*_ENABLED` (env vars — §28.9).
- `STAGING_MODE`, `TEST_OVERRIDE_EMAIL`, `TEST_OVERRIDE_PHONE` (env vars, used by Part 6 Prompt 25/26 staging controls).
- Most other operational toggles (RAG submission limits, tone caps, persona configuration) live in `platform_settings` or `tier_definitions` per earlier prompts.
- Document in `docs/runbooks/feature-flags.md` which toggles are env-vs-DB and how to change each.
1. **NEXT_PUBLIC_* discipline — §28.22 fourth call-out.** Add a lint rule:
- Any variable name starting with `NEXT_PUBLIC_` MUST NOT appear in the “secret” section of the Zod schema. Build a unit test that walks the schema and asserts no `NEXT_PUBLIC_` variable is marked as secret.
- During code review: PRs that add a new `NEXT_PUBLIC_*` variable trigger a CODEOWNERS check for a security reviewer (document in `.github/CODEOWNERS`).
1. **Local development guidance — §28.21.** Update `docs/local-development.md`:
- `.env.example` is the canonical reference.
- Developers create `.env.local` (gitignored) with their own values.
- Each developer should use:
  - Their own shadow Supabase project (Free tier; gets reset frequently for testing).
  - Stripe test mode keys.
  - Anthropic key with a personal monthly limit cap.
  - OpenAI key with a personal monthly limit cap.
  - Inngest cloud account with personal signing key OR local Inngest dev server.
- The `verifyEnvAtBoot` check at start of `pnpm dev` ensures local environments fail loudly on misconfiguration — no surprises in production.
1. **Vendor pricing is NOT env vars — §28.18.** Per §27.12 / §28.18: vendor pricing is data, fetched daily and cached in `platform_settings.ai_pricing_catalog`. Confirm there are NO env vars in the schema for vendor pricing values. Add an assertion in a test: the Zod schema does not contain keys matching `*_PRICE_PER_*` (other than Stripe price IDs which are different — stable Stripe-issued identifiers, not pricing values).
1. **Tests.**
- **Boot verification**: a missing `ANTHROPIC_API_KEY` → `verifyEnvAtBoot` exits with structured error listing the missing var. A malformed key (`ANTHROPIC_API_KEY=hello`) → exits with the validation error.
- **Multiple errors at once**: missing both `ANTHROPIC_API_KEY` and `STRIPE_SECRET_KEY` → both surfaced in the error output, not just the first.
- **Conditional**: `OAUTH_MICROSOFT_ENABLED=true` without `MICROSOFT_GRAPH_CLIENT_ID` → exits with error pointing to the conditional requirement.
- **Apple deferred**: `OAUTH_APPLE_ENABLED=false` (default) does not require any Apple vars.
- **Stripe key shape**: `STRIPE_SECRET_KEY=sk_invalid_format` → schema rejects.
- **Stripe test/live mismatch (procedural)**: integration test sets `STRIPE_SECRET_KEY=sk_test_...` AND asserts the runbook is documented. (No automated check that price IDs match mode — that’s the limitation documented in MEMORY.)
- **No NEXT_PUBLIC_* in secrets**: the schema-walking test asserts no key starting with `NEXT_PUBLIC_` is marked secret.
- **Vendor pricing NOT in env**: schema-walking test asserts no `*_PRICE_PER_MILLION_*` style keys.
- **`.env.example` matches schema**: a meta-test compares the keys in `.env.example` against the Zod schema; any missing key fails.
1. **Add to MEMORY.md at end of run:**
- Discrepancies found between code-side env-var population and §28 — list each (vars in code but not spec, vars in spec but not yet in code).
- Conditional vars (Microsoft, Apple, Gmail) and how the schema handles them.
- Stripe price-ID test/live mode separation is procedural (runbook), not enforced in code — documented as a known limitation.
- The secret rotation runbook lives at `docs/runbooks/secret-rotation.md`.
- Local dev guidance lives at `docs/local-development.md`.
- The boot-time verification is wired in both `apps/main/src/instrumentation.ts` and `apps/rag/src/instrumentation.ts`.

**Definition of done:**

- Both main app and RAG service refuse to start when required env vars are missing or malformed.
- Boot-time errors are structured and list all missing/invalid vars at once.
- `.env.example` mirrors the Zod schema exhaustively for both services.
- The secret rotation runbook covers every secret class with operator-actionable steps.
- Lint and meta-tests prevent regressions (no NEXT_PUBLIC_ secrets, no vendor pricing in env, `.env.example` parity with schema).
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 15.
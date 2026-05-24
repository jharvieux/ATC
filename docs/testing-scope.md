# Testing scope — what we test and what we don't

**Owner:** platform operator
**Spec ref:** §30.11
**Audience:** anyone trying to understand what the test suite does and doesn't guard

The point of this doc is to be **explicit** about non-coverage. Hidden
gaps are the worst kind. A documented gap is a known risk; an undocumented
gap is a future incident.

## What IS tested

### Unit (605 tests, runs on every PR)

- Pure functions: pricing math, threshold resolution, persona resolution, RAG chunk scoring, etc.
- Library modules: cipher, env validation, audit-log writer, factories, lint-rule logic.
- Zod schemas: every entry in the env schema is validated; shape changes break the test.
- Email rendering: each React Email template renders to HTML without throwing.

### Integration (deferred — testcontainers scaffold in place, no integration tests yet)

The `apps/main/src/test/db-setup.ts` helper is the home for these when
the first integration test arrives. The pattern:

```ts
it.skipIf(!process.env.INTEGRATION_DB)(
  "RLS prevents tenant B from reading tenant A bookings",
  () => withTestDatabase(async (db) => { ... }),
);
```

When written, integration tests cover:

- Tenant isolation under real RLS (not mocked)
- Audit-log writes happen on the right code paths
- Migrations apply cleanly against a fresh DB

### Security (47 tests, runs on every PR)

- Cross-tenant route probe (existing, BP04)
- Cross-tenant Inngest probe (BP30 Phase A, static)
- TenantContext factory audit (BP30 Phase A, adversarial inputs)
- Auth bypass probe (BP30 Phase A, static import check)
- Service-role lint discipline (BP30 Phase A, structural guard)
- Probe self-tests (BP30 Phase A)

### Contracts (BP26)

- Anthropic SDK shape (MSW replay)
- Stripe SDK shape (MSW replay)

### E2E (Playwright, 12 specs in `tests/e2e/`)

- Critical-path user journeys: signup, agent discovery, agent chat, booking flow, quotes, customer portal, admin console, onboarding, health, help, price watch, email connection.

### Schema discipline (BP29)

- §28 env-var coverage parity with `.env.example`
- No `NEXT_PUBLIC_*` secret-shaped names
- No vendor pricing in env

### CI gates

- Lint (`pnpm -r lint`) — service-role discipline + no-money-math + no-ad-hoc-tenant-id + no-direct-anthropic/openai-import
- Typecheck (`pnpm -r typecheck`)
- Migration lint (`pnpm lint:migrations`)
- RLS snapshot diff (`pnpm rls:check`) — drift between code policies and committed snapshot
- RLS coverage check (`pnpm rls:coverage`) — silent-deny + `USING(true)` + missing-CMD policy + SECURITY DEFINER `search_path`
- Vitest with coverage (informational, NOT a merge gate)
- Cross-tenant probe job
- Secret scan + CVE scan

## What is NOT tested (§30.11)

### Visual rendering

- **Pixel-perfect rendering across browsers** — Playwright covers happy-path layouts in Chromium only. Firefox / WebKit / Edge are spot-checked manually before release. No vendor automation (Percy/Chromatic deliberately deferred per BP30 Phase A scope decision; revisit when UI changes get noisy enough to justify the spend).
- **Mobile-web responsive breakpoints** are not in the Playwright matrix; manual review only.

### Internationalization

- **All user-facing copy is English-only at launch** (§25.8). No i18n string-table coverage; no RTL layout tests; no locale-specific date / currency formatting tests beyond US.
- **AI responses in non-English languages** are out of scope. The chat handler doesn't refuse non-English input, but eval coverage assumes English transcripts.

### Mobile native

- **No native iOS / Android apps in v6.2** (§2.1). The web app is responsive but no native test harness exists.

### Email rendering across clients

- React Email renders the templates; we manually spot-check the rendered HTML in Gmail, Outlook (web + desktop), and Apple Mail before any template change ships. **No automated cross-client matrix** (Litmus / Email on Acid not subscribed).

### Accessibility

- **Automated a11y audit (axe-core, Lighthouse a11y, etc.) is NOT in CI.** We run Lighthouse manually before major releases against the critical-path pages. Full automation deferred until staff bandwidth supports remediation queue.

### AI evaluation

- **AI behavior eval harness with Claude-as-judge is deferred entirely** (BP30 cost-deferral decision). The `apps/main/evals/` directory does not exist; no nightly judge calls; no continuous-sampling cron; no `ai_sampling_results` table.
- Regression detection on AI quality is therefore manual: operators sample chat transcripts in the platform admin console + react to customer-reported issues.
- **Re-enable trigger:** when first AI-quality regression that an eval harness would have caught reaches production AND costs more than ~$50/month of judge calls would have. Then provision and wire up.

### Load / performance

- **k6 load tests are out-of-CI by design** (§30.7 + `docs/runbooks/load-testing.md`). Manual cadence: monthly first 6 months post-launch, then 4-8 weeks thereafter.

### SLA contract testing

- **No SLAs signed at v6**. No uptime / latency contract assertions; only the §30.5 internal targets.

### Production behaviors

- **Stripe Connect onboarding against real Stripe** — covered by manual smoke before each release. Stripe test mode used in all automated paths.
- **Real OAuth provider flows** — same: manual smoke against Google / Microsoft / Facebook before releases that touch the OAuth callback.
- **Real Resend webhook delivery** — Resend's own status page is the monitor; we don't probe their deliverability.
- **DNS / domain claim flow against real Vercel / Cloudflare** — covered by the `crown-jewel-annual-audit` reminder + a manual run-through before any custom-domain change.

## How to add coverage

When a gap above becomes load-bearing enough to need coverage:

1. **Pick the gap.** Cite §30.11 (or this doc) in the PR description.
2. **Estimate cost.** If it requires new infra (test DB, k6 env, AI judge calls), bring options to the operator first. The cost-deferral decisions in MEMORY D-063 / D-064 are reversible; just be explicit.
3. **Pick the test layer.** Unit > integration > E2E in order of preference, per §30.2.
4. **Update this doc.** Move the gap from the NOT tested section to the IS tested section in the same PR.

## Vitest config notes (BP30 Phase B audit)

- Single shared `vitest.config.ts` at repo root; `apps/rag/vitest.config.ts` for RAG-side tests.
- `testTimeout: 30000` (30s). Tests above the §30.5 targets (unit < 100ms, integration < 5s, E2E < 60s) are warnings, not failures.
- No explicit unit / integration / security environment split — files are categorized by directory: `apps/main/test/unit/`, `apps/main/test/integration/`, `tests/security/`. The full Vitest run executes all of them.
- Coverage provider: `v8`, scoped to `scripts/**/*.ts`. **Informational only**, not a merge gate (per §30.10).
- Full suite executes in ~1.5s wall-clock for 605 tests — well under the §30.5 15-minute PR budget. Headroom is plenty.

## Related

- `docs/runbooks/load-testing.md` — how to run k6 scenarios
- `docs/runbooks/flaky-test-policy.md` — 7-day quarantine + delete rule
- §30.10, §30.11 spec

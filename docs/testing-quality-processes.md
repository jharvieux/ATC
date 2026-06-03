# Testing and Quality Processes

A full inventory of every automated check, test process, and code-review subagent in this codebase — with enough detail to replicate the setup in a new project, and clear guidance on what applies universally vs. what is conditional on specific architectural choices.

---

## Quick Reference

| Process | Category | Universality | Trigger |
|---------|----------|--------------|---------|
| TypeScript typecheck | Static analysis | **Universal** | PR CI |
| ESLint (+ custom rules) | Static analysis | Universal core; rules project-specific | PR CI |
| Vitest unit tests | Testing | **Universal** | PR CI |
| Secret scan (GitGuardian) | Security | **Universal** | PR CI |
| CVE scan (`pnpm audit`) | Security | **Universal** | PR CI |
| SonarCloud | Static analysis / security | **Universal** | PR CI |
| CodeQL | Static analysis / security | **Universal** | PR CI |
| Duplication check (jscpd) | Code quality | **Universal** | PR CI |
| Slop check (diff-aware) | Code quality | **Universal pattern**; rules configurable | PR CI (local) |
| Playwright E2E | Integration testing | **Universal** | PR CI |
| Contract tests (MSW replay) | API contract testing | When external APIs are called | PR CI |
| d091-reviewer subagent | Code review | **Universal for Supabase+Next.js+AI**; partially universal | Every PR |
| pre-pr-reviewer subagent | Code review | **Universal** | Every PR |
| pr-audit-section-check | Process enforcement | **Universal** (with audit subagents) | PR CI |
| Dependency ignore watch | Dependency hygiene | Universal when you hold back major bumps | Monthly cron |
| Dependabot + cooldown + automerge | Dependency hygiene | **Universal** | Daily |
| Dependabot regression detector | Dependency hygiene | Universal | On Dependabot PR |
| RLS snapshot + diff | DB security | **Supabase multi-tenant apps** | PR CI |
| Grants snapshot + diff | DB security | **Supabase apps** | PR CI |
| Dropped column reader guard | DB migration safety | Supabase JS or any string-query ORM | PR CI |
| Page service-role guard | Auth / privilege escalation | Next.js App Router + Supabase service role | PR CI |
| Auth error adoption check | API consistency | Apps with centralized auth error handler | PR CI |
| Cross-tenant probe | Tenant isolation | **Any multi-tenant SaaS** | PR CI + nightly |
| Nightly full test suite | Integration testing | Apps with DB-backed nightly tests | Nightly cron |
| Contracts canary | API drift detection | Apps with recorded API fixtures | Nightly cron |
| Stryker mutation testing | Test quality | Apps wanting to validate test effectiveness | On-demand |

---

## Universal Processes

These apply to essentially any production web application and should be set up from day one on any new project.

---

### 1. TypeScript Typecheck

**What it does:** Runs `tsc --noEmit` across the whole codebase. Catches type errors, missing imports, broken interfaces.

**Implementation:**
```json
// package.json
"typecheck": "pnpm -r typecheck"

// apps/main/package.json
"typecheck": "tsc --noEmit"
```

**CI step:** Required check in `deploy.yml`. Runs before tests.

**New project notes:** Wire this first, before anything else. Every other quality gate depends on types being valid.

---

### 2. ESLint

**What it does:** Lints TypeScript/JavaScript for quality, style, and security issues.

**Implementation:**
- `eslint-config-next` base + `@typescript-eslint` + `sonarjs` plugin
- `jscpd` integration for duplication warnings
- Custom project-specific rules (see below)

**Universal rules in this project:**
- `atc/no-orphan-todo` — TODOs must reference an owner or issue number (`TODO(owner)` or `TODO(#123)`)
- `sonarjs` — catches common logical errors and code smells

**Project-specific custom ESLint rules in this project:**
- `atc/no-direct-anthropic-or-openai-import` — only `lib/ai/call-wrapper.ts` may import the Anthropic/OpenAI SDK directly. Enforces vendor instrumentation (cost logging, health tracking) can't be bypassed. **Apply to:** any project with AI SDK usage that must be instrumented for cost tracking or rate limiting.

**New project notes:** The no-orphan-todo rule is valuable on any AI-assisted codebase. The AI-import restriction is only needed if you have a wrapper layer for AI SDK calls.

---

### 3. Vitest Unit Tests

**What it does:** Runs unit and integration tests defined in `apps/main/test/**/*.test.ts` and root `tests/**/*.test.ts`.

**Implementation:**
```json
// package.json
"test": "vitest run --coverage --passWithNoTests"
```

**Key conventions in this project:**
- Tests live alongside the code they test (in `test/unit/` subdirectories mirroring `src/`)
- Tests must encode WHY behavior matters (the `§ reference` comment convention), not just WHAT it does
- A test that can't fail when business logic changes is wrong and must be rewritten

**New project notes:** Fully universal. The convention of encoding the security/business reason in the test comment is valuable for any project where tests serve as living documentation.

---

### 4. Secret Scan (GitGuardian)

**What it does:** Scans every commit for secrets, API keys, credentials.

**Implementation:** GitGuardian GitHub App. Runs automatically on every push. Required status check.

**New project notes:** Install the GitHub App. Zero configuration needed. Free tier covers most use cases.

---

### 5. CVE Scan (`pnpm audit`)

**What it does:** Checks npm dependency tree against known CVE database.

**Implementation:**
```yaml
# deploy.yml
- run: pnpm audit --audit-level=critical      # blocks on critical
- run: pnpm audit --audit-level=high --json   # warns on high, doesn't block
```

Two-tier: critical CVEs block the PR; high CVEs produce a warning (annotated in CI).

**New project notes:** The two-tier approach is worth copying: hard-blocking on `high` produces too much noise from transitive dependencies that have no exploitable path. Block on `critical`, warn on `high`, manually triage `high` warnings periodically.

---

### 6. SonarCloud

**What it does:** Static analysis for bugs, vulnerabilities, code smells. Also flags ReDoS-prone regex patterns (S5852) and other security hotspots.

**Implementation:** GitHub App + `sonarcloud.io` project. Automatic on PRs.

**Key experience from this project:**
- S5852 (ReDoS) hotspots often fire on regex patterns that don't have polynomial backtracking in practice (e.g., `^[^\s@]+@[^\s@]+\.[^\s@]+$`). The fix is to add an input-length cap before the regex, not to rewrite the regex.
- Mark false positives as "Safe" in the SonarCloud UI — they'll stop appearing in future PRs.

**New project notes:** Universal. The input-length-before-regex pattern is good practice regardless of SonarCloud.

---

### 7. CodeQL

**What it does:** GitHub's static analysis engine. Catches security vulnerabilities (XSS, injection, SSRF, etc.) through semantic code analysis, not pattern matching.

**Implementation:** `.github/workflows/codeql.yml`. Standard GitHub setup.

**New project notes:** Universal. Free for public repos, included in GitHub Advanced Security for private. Enable it.

---

### 8. Code Duplication Check (jscpd)

**What it does:** Detects copy-pasted code blocks above a configurable token threshold.

**Implementation:**
```json
// package.json
"check:duplication": "jscpd --config .jscpd.json"
```
```json
// .jscpd.json — key settings
{
  "threshold": 5,
  "minLines": 6,
  "minTokens": 80,
  "reporters": ["consoleFull"]
}
```

**New project notes:** Universal. The thresholds matter — too low and you get noise from legitimate patterns (test boilerplate, route handlers); too high and real duplication slips through. Start with `minLines: 6, minTokens: 80`.

---

### 9. Slop Check (diff-aware)

**What it does:** Scans the current PR diff for AI-generated code quality issues:
- Orphan TODO/FIXME/HACK markers (no owner or issue ref)
- Narrating comments that describe WHAT code does instead of WHY
- Try/catch blocks that just re-throw
- Single-line export wrappers

**Implementation:** `scripts/slop-check.ts` — runs `git diff origin/dev..HEAD` and reports findings. Exit 0 (advisory, doesn't block CI). Runs as part of `pnpm verify` locally.

**New project notes:** Universal and especially valuable for AI-assisted codebases. The categories above are all patterns that AI models produce naturally when they're filling space rather than solving problems. Even if you don't auto-enforce it in CI, the script is a useful local quality gate.

---

### 10. Playwright E2E Tests

**What it does:** Browser-level end-to-end tests across authenticated flows, booking, admin console, etc.

**Implementation:**
- `.github/workflows/e2e.yml` runs on PRs
- Tests live in `tests/e2e/*.spec.ts`
- Tier 1 (critical path), Tier 2 (extended), Tier 2.5 (flakiness-prone, lower confidence)

**New project notes:** Universal. The tiering system (Tier 1 = must-pass, Tier 2 = should-pass, Tier 2.5 = best-effort) is worth adopting for any non-trivial E2E suite — it avoids the dynamic where flaky tests cause developers to ignore all E2E failures.

---

### 11. d091-reviewer Subagent

**What it does:** Claude Code subagent that reviews every PR diff for 14 specific anti-patterns derived from production incidents in this codebase. Posts a marker comment (`<!-- d091-audit:v1 -->`) to the PR.

**Anti-patterns reviewed:**
1. Unchecked Supabase mutations (`.update()`, `.insert()` etc. without error checking)
2. Zero-row CAS guard missing (`.update().eq().eq()` without row count verification)
3. Fail-open enforcement (returning `allowed: true` on error)
4. Single-layer tenant isolation
5. External credentials in URLs (should be in headers)
6. Unjustified `void` on async in serverless
7. Multi-action permission gates (one `assertPermission` for two different operations)
8. Idempotency rows written before dispatch
9. State-machine boundary validation missing
10. Webhook signature encoding mismatch
11. Stub-shaped code (parameters that don't affect output)
12. Quota gates not re-read between consuming operations
13. Destructive migrations bundled with expand/contract steps
14. Slop

**Universality:**
- Patterns 1–4, 11–14: **Universal** for any app using Supabase JS v2 and multi-tenant data
- Pattern 3 (fail-open): **Universal** — applies to any enforcement layer
- Pattern 5 (credentials in URLs): **Universal**
- Pattern 6 (`void` async in serverless): **Universal** for Vercel/Lambda
- Patterns 7–10: Universal for any app with webhooks, state machines, or idempotent operations
- The Supabase-specific patterns (1, 2, 4) need adaptation for other ORMs

**Implementation:** Defined as a Claude Code agent type (`d091-reviewer`) in `.claude/agents/`. Invoked manually before every PR is merged.

**New project notes:** The patterns themselves are worth encoding even without the automated agent. For a new travel agency app using the same stack (Next.js + Supabase + Vercel + Inngest), copy the d091-reviewer agent definition verbatim — all 14 patterns apply. For a different stack, adapt patterns 1 and 2 to the ORM in use.

---

### 12. pre-pr-reviewer Subagent

**What it does:** Claude Code subagent that reviews PRs for code quality, independent of D-091 security patterns. Posts `<!-- prepr-audit:v1 -->` marker comment.

**What it checks:**
- Slop sweep (orphan TODOs, what-comments, useless try/catch, single-use helpers)
- Tests-for-intent: tests must encode WHY behavior matters, not just WHAT it does
- Surgical changes discipline: diffs should only touch what the task requires
- Honesty-about-uncertainty: no guessed facts presented as certain
- Codebase convention drift: new code should match existing patterns
- Stub-shaped code (same as D-091 pattern 11, from a different angle)

**Universality:** **Universal** — these quality checks apply to any codebase, any stack.

**Implementation:** Defined as a Claude Code agent type (`pre-pr-reviewer`) in `.claude/agents/`. Invoked manually before every PR.

**New project notes:** Copy this agent verbatim to any project. The rules it enforces are general software engineering discipline, not project-specific.

---

### 13. pr-audit-section-check (GitHub Actions)

**What it does:** Enforces that BOTH subagent marker comments exist in the PR AND were posted after the current head commit. Exempts bot PRs (Dependabot) and doc-only PRs (`*.md`, `docs/**`, `specs/**`).

**Why two layers:**
1. **PR body `## Audit` section** — human-readable summary (could be faked)
2. **PR comment with marker** — timestamped, compared against head commit date (harder to fake without consciously lying)

**Implementation:** `.github/workflows/pr-audit-section-check.yml`. Set as a required status check on the `dev` branch.

**Key design decisions:**
- Triggers on `edited` event so fixing the PR body re-runs the check (without this, you'd need a no-op commit to re-trigger)
- Bot exemption is done inside the job (not as a job-level `if:`) so the job always reports a status — necessary for Dependabot automerge to work
- Doc-only detection fetches the file list via GitHub REST API, not from the diff — handles renames/deletes correctly

**New project notes:** Fully reusable. Copy the workflow file. Update the branch protection required-status-check name to match. The only project-specific part is the list of doc-pattern exceptions — add `content/**` or similar if your project has other non-code directories.

---

### 14. Dependabot (with cooldown + groups + automerge)

**What it does:** Automated dependency update PRs. Configured with:
- Daily schedule
- 1-day cooldown (avoids immediate major-incident re-deployment)
- Groups: `production-minor-patch`, `dev-dependencies` (reduces PR volume)
- `automerge-candidate` label for CI-green minor/patch bumps
- Explicit `ignore` entries for major bumps with documented reasons

**Implementation:** `.github/dependabot.yml` + `.github/workflows/dependabot-automerge.yml`

**Dependency ignore pattern:** Each ignored major bump includes a comment explaining WHY and references a `gating_by` package. The `dependency-ignore-watch.yml` monthly cron polls when the gate clears. **Never add an ignore entry without documenting it.**

**New project notes:** Universal. The cooldown, groups, and documented-ignore pattern are all worth copying. For a new travel agency app: carry over the react/vite/eslint ignore entries if you're on the same major versions.

---

### 15. Dependabot Regression Detector

**What it does:** When a Dependabot PR's CI fails, posts a comment identifying whether the failure looks like a known-broken transitive dependency (adds `regression-suspected` label) or something new.

**Implementation:** `.github/workflows/dependabot-regression-detector.yml`

**New project notes:** Universal utility. Copy it to any project using Dependabot. Saves time distinguishing "CI is flaky" from "this upgrade actually broke something."

---

## Conditional: Supabase Multi-Tenant Apps

These checks apply to any application using Supabase with multi-tenant row-level security. For a new travel agency app on the same stack, apply all of them.

---

### 16. RLS Snapshot + Diff

**What it does:** Captures a snapshot of all Row-Level Security policies in the Supabase database and compares them on every PR. Fails (or warns on dev) if policies drifted without an intentional migration.

**Implementation:**
```bash
# Capture snapshot
pnpm rls:snapshot        # writes db/rls-snapshot-main.sql + db/rls-snapshot-rag.sql

# Check drift on PR
pnpm rls:check           # fails if current DB policies != snapshot file
```
- `scripts/rls-snapshot.ts` — connects to Supabase, queries `pg_policies`, writes SQL
- `scripts/rls-snapshot-diff.ts` — diffs current policies against committed snapshot

**CI behavior:** Fails the PR if drift is detected. Developer must run `pnpm rls:snapshot`, review the diff, and commit the updated snapshot file.

**New project notes:** Apply to any Supabase project with RLS. For a new travel agency app: copy scripts verbatim; update the target project IDs in the Supabase MCP configuration.

**Applicability signals:**
- You're using Supabase with `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- You have multi-tenant data and care about cross-tenant leakage
- You want to catch accidental RLS changes before they reach production

---

### 17. Grants Snapshot + Diff

**What it does:** Same pattern as RLS snapshot but for PostgreSQL `GRANT` statements. Catches accidental privilege escalation from migrations.

**Implementation:**
```bash
pnpm grants:snapshot     # writes db/grants-snapshot-main.sql
pnpm grants:check        # fails if current grants != snapshot
```
- `scripts/grants-snapshot.ts` + `scripts/grants-snapshot-diff.ts`

**New project notes:** Apply alongside RLS snapshot for any Supabase project. The combination catches both "who can see what rows" (RLS) and "who can perform what operations" (GRANT) drift.

---

### 18. Dropped Column Reader Guard

**What it does:** Static analysis that scans source code for string-based column references inside Supabase query chains (`.from("table").select("column")`) and fails if any referenced column was dropped in a recent migration.

**Why this matters:** `tsc` cannot detect that a column was dropped — the column name is a string, not a TypeScript type. This check is the backstop against the pattern: migration drops column → app code still references it → 500 errors in production (see D-038 in MEMORY.md).

**Implementation:**
- `scripts/check-dropped-column-readers.ts` — table-aware, whole-word matching
- `pnpm check:dropped-columns`
- CI step in `deploy.yml`

**Limitations:** Only catches columns named as string literals near their `.from()` chain. `.select("*")` followed by `row.column_name` slips through.

**New project notes:** Apply to any project using Supabase JS (or any ORM where column names are strings). For a new travel agency app: copy the script. The dropped-column list is derived from the migration history — no manual configuration.

**Applicability signals:**
- You use Supabase JS `.select("column_name")` patterns
- You perform database column renames or drops as part of the expand-migrate-contract pattern
- You've been burned by runtime errors from dropped columns before

---

### 19. Page Service-Role Guard

**What it does:** Static analysis that ensures every Next.js App Router `page.tsx` that imports `createServiceRoleClient` (bypasses RLS, can read any tenant's data) is either inside the `(admin)/` route group (gated by admin auth) or explicitly allowlisted with a justification.

**Implementation:**
- `scripts/check-page-service-role.mjs` — walks `src/app/`, checks any `page.ts[x]` using `createServiceRoleClient`
- `scripts/page-service-role-allowlist.mjs` — explicit allowlist with justification strings
- `pnpm check:page-service-role`
- Also has a Vitest test: `tests/security/page-service-role.test.ts`

**New project notes:** Apply to any Next.js App Router + Supabase project that has service-role access. For a new travel agency app: copy both scripts. The allowlist will be empty initially — add entries only with explicit justification.

**Applicability signals:**
- You use Next.js App Router with server components
- You have a Supabase service-role client that bypasses RLS
- You have both admin routes and public/tenant routes

---

### 20. Auth Error Adoption Check

**What it does:** Verifies that every route using `assertPermission` (the centralized auth/permission gate) pipes its errors through `respondToAuthError`. Prevents auth errors from being returned as raw 500s with internal details exposed.

**Implementation:**
- `scripts/check-auth-error-adoption.mjs` — walks route files, checks pairing
- `pnpm check:auth-error`
- CI step in `deploy.yml`

**New project notes:** Adapt to whatever centralized auth error handler your project uses. The pattern generalizes: "every route that calls the auth gate must handle errors through the standard error handler." The script is simple — rewrite for your function names.

**Applicability signals:**
- You have a centralized `assertPermission` or `requireAuth` function
- You have a standardized error response format
- You've had incidents where auth errors leaked internal details

---

## Conditional: Multi-Tenant SaaS

These apply to any application with strict tenant isolation requirements — not just travel agencies.

---

### 21. Cross-Tenant Probe

**What it does:** Black-box security test. Authenticates as Tenant B, then attempts to access resources belonging to Tenant A on every API route. Any 2xx response indicates a cross-tenant data leak.

**Implementation:**
- `tests/security/cross-tenant-probe.test.ts` — route enumerator + fixture-based probe
- `tests/security/cross-tenant-allowlist.json` — routes that legitimately return 2xx without tenant auth (public endpoints)
- Runs in CI as the `Cross-Tenant Probe` step

**Current state:** The route enumeration (filesystem check) runs on every PR. The full DB-backed probe (real tenant JWTs + seeded data) requires `CROSS_TENANT_FIXTURES=true` + a dedicated test Supabase project (blocked on #386).

**New project notes:** The concept applies to any multi-tenant app — implement it even if the full fixture setup comes later. Starting with the route enumeration (are the right routes even in the allowlist?) provides immediate value.

**Applicability signals:**
- Multiple tenants share the same database
- Tenant isolation is enforced at the application layer (not just separate databases)
- A data leak between tenants would be a significant security incident

---

### 22. Two-Layer Tenant Isolation (D-091 Pattern 4)

**What it does:** Every tenant-scoped database query must have BOTH an app-layer filter AND a database-layer constraint. The d091-reviewer explicitly checks for this on every PR.

**Implementation:** Enforced via:
- `tenantClient()` — creates a Supabase client with RLS-enforcing tenant context
- Service-role queries must have explicit `.eq("tenant_id", ...)` filters
- The `d091-reviewer` subagent checks for single-layer queries on every PR diff

**New project notes:** The two-layer principle applies to any multi-tenant app regardless of database. "One layer is one bug away from a breach."

---

## Conditional: External API Integrations

---

### 23. Contract Tests (MSW Replay)

**What it does:** Tests that the app correctly handles recorded API responses from external services. MSW intercepts HTTP calls and replays fixture files. The CI check `Contract Tests` fails if fixture shapes drift or if app code stops reaching the expected endpoints.

**Implementation:**
- `tests/contracts/fixtures/` — recorded API responses (JSON)
- `tests/contracts/setup.ts` — MSW server setup, loads all fixtures
- `tests/contracts/anthropic/chat.test.ts` — Anthropic Messages API contract
- `tests/contracts/stripe/customers.test.ts` — Stripe API contracts (customers, subscriptions, Connect)
- `scripts/record-contracts.ts` — re-records fixtures against real APIs
- `pnpm test:contracts`

**Technical note on Stripe SDK:** Stripe SDK v22 uses an HTTP client path that MSW v2 interceptors don't cover. The Stripe contract tests use raw `fetch()` instead of the SDK — this still verifies fixture response shapes but doesn't test SDK parsing. Switch to SDK-based tests if/when MSW adds undici interception.

**New project notes:** Apply to any project calling external APIs with versioned contracts. Especially valuable when:
- You depend on a paid API and can't make test calls freely
- The API has breaking changes between versions
- You need to verify response parsing in CI without real credentials

**When to record fixtures:** On first integration, and whenever the API version changes or the provider announces a shape change. Store fixtures in version control.

**Applicability signals:**
- You call Anthropic, Stripe, or any other external API
- The API has a stable response shape you depend on
- You want to catch drift before it reaches production

---

### 24. Contracts Canary (Nightly)

**What it does:** Re-records API fixture files nightly against real APIs and diffs them against the committed fixtures. Opens an issue if the response shapes drifted (API silently changed).

**Implementation:** `.github/workflows/contracts-canary.yml`
- Requires: `STRIPE_TEST_SECRET_KEY`, `ANTHROPIC_API_KEY_TEST`
- Runs `scripts/record-contracts.ts`, then diffs against committed fixtures
- Opens a GitHub issue if drift is detected

**New project notes:** Apply when you have recorded API fixtures and want automatic drift detection. The nightly cadence catches API changes before they cause production incidents. Requires real API credentials stored as GitHub secrets.

---

## Conditional: AI/LLM Applications

---

### 25. Input Length Caps Before Regex (S5852)

**What it does:** Any regex applied to user input (especially email validation patterns) must be preceded by a length cap. The cap prevents pathological inputs from triggering O(n²) regex backtracking.

**Pattern:**
```typescript
// Email validation — cap at RFC 5321 max (254 chars) before regex
if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  return Response.json({ error: "Invalid email address" }, { status: 400 });
}

// Chat message — cap before any PII redaction regex runs
if (rawUserMessage.length > 8000) {
  return new Response(JSON.stringify({ error: "message_too_long" }), { status: 400 });
}
```

**Why it matters:** SonarCloud flags `\s*[:#-]?\s*` and similar patterns as S5852 hotspots. The actual risk is that a crafted input (e.g., "passport" + 8000 spaces) could cause CPU spikes. The length cap neutralizes the attack without requiring a regex rewrite.

**New project notes:** Apply to any application accepting user-provided strings that are validated by regex. The specific cap values (254 for email, 8000 for messages) are based on RFC 5321 and a reasonable UX limit respectively — adjust for your application's constraints.

---

### 26. AI Cost State Machine (Abuse Prevention)

**What it does:** All AI API calls route through a state machine that tracks per-tenant AI spend. Enforces soft1 (downgrade model), soft2 (warn user), and hard (reject call) thresholds. The d091-reviewer checks that no code bypasses this wrapper.

**Implementation:**
- `apps/main/src/lib/ai/call-wrapper.ts` — the only file allowed to import Anthropic/OpenAI directly
- `apps/main/src/lib/abuse/` — state machine, snapshot, thresholds
- ESLint rule `atc/no-direct-anthropic-or-openai-import` enforces the single-entry-point pattern

**New project notes:** Apply to any application where AI API costs are variable and abuse is a concern. The pattern (single instrumented wrapper, ESLint enforcement) generalizes to any paid API with per-call costs.

---

## Process Infrastructure

---

### 27. `pnpm verify` (Local Quality Gate)

**What it does:** Single command that runs the full quality pipeline locally before pushing.

```bash
pnpm verify = typecheck + lint + test + slop-check + check:auth-error + 
              check:dropped-columns + check:duplication + check:page-service-role
```

**Why it exists:** CI runs cost minutes and create PR noise. Running locally first surfaces breaks while you still have context to fix them.

**New project notes:** Define a `verify` script in every project that runs the full CI-equivalent locally. The specific steps depend on which checks you've set up. This is the single most valuable developer experience improvement — "does my change pass CI?" answered in 30 seconds locally.

---

### 28. Nightly Full Test Suite

**What it does:** Runs the full DB-backed integration suite (RLS tests, cross-tenant Inngest probes, destructive cron simulations) nightly against a **dedicated test Supabase project** — not the production DB. Sends a GitHub issue if it fails.

**Why nightly, not per-PR:** These tests involve real DB state, destructive crons, and take too long for PR CI. They catch regressions that unit tests miss.

**Implementation:** `.github/workflows/nightly-full-test.yml`

**Critical prerequisite:** The nightly suite must point at a dedicated test Supabase project, not the production project. Once customer data exists in production, running destructive crons against it would be catastrophic. See issue #386 for the migration plan.

**New project notes:** Apply to any project where some integration tests are too slow or too destructive for PR CI. The dedicated-test-project requirement is non-negotiable once real data exists.

---

### 29. Dependency Ignore Watch (Monthly Cron)

**What it does:** For every dependency held back with a `dependabot.ignore` entry, polls npm monthly to check if the `gating_by` package now admits the blocked major version in its `peerDependencies`. Opens a re-test issue when the gate clears.

**Why this matters:** Dependabot `ignore` entries are silent — without this, a held-back major update just silently accumulates security debt indefinitely.

**Implementation:**
- `.github/workflows/dependency-ignore-watch.yml` — monthly schedule
- `.github/dependency-ignore-watch.json` — config: package, blocked version, gating package
- `scripts/check-dependency-ignores.ts` — logic

**New project notes:** Apply to any project that blocks major dependency bumps. The investment is low (one config entry per held-back dep) and the payoff is automatic notification when it's safe to re-evaluate.

---

### 30. CLAUDE.md Coding Standards

**What it does:** Documents the coding standards that both human developers and Claude Code are expected to follow. The pre-pr-reviewer subagent enforces these automatically on every PR.

**Key universal standards in this project's CLAUDE.md:**
- No comments explaining WHAT code does — only WHY (hidden constraints, non-obvious invariants)
- No orphan TODOs — must reference `owner` or `#issue`
- No mock-DB integration tests — use real DB or test against real fixtures
- Fail-closed defaults — every enforcement layer returns denial on error
- Surgical changes — diffs should only touch what the task requires
- No stub-shaped code — every parameter must affect the output

**New project notes:** Write a CLAUDE.md on day one of any project that uses Claude Code. The standards above are universal. Add project-specific rules as patterns emerge (e.g., the AI-import restriction, the auth-error pairing requirement).

---

## Applicability Checklist for New Travel Agency Apps

When setting up a similar travel agency SaaS on the same stack (Next.js + Supabase + Vercel + Inngest + Stripe + Anthropic):

**Copy verbatim (no changes needed):**
- [ ] `pr-audit-section-check.yml` workflow
- [ ] `dependabot-automerge.yml` + `dependabot-regression-detector.yml`
- [ ] `dependency-ignore-watch.yml` + `.github/dependency-ignore-watch.json`
- [ ] `d091-reviewer` agent definition
- [ ] `pre-pr-reviewer` agent definition
- [ ] `CLAUDE.md` (update project name + tenant IDs)
- [ ] `scripts/slop-check.ts`
- [ ] Contract test structure (`tests/contracts/setup.ts` + fixture directory)

**Copy and adapt (update project/DB references):**
- [ ] `scripts/rls-snapshot.ts` + `rls-snapshot-diff.ts` — update Supabase project IDs
- [ ] `scripts/grants-snapshot.ts` + `grants-snapshot-diff.ts` — update project IDs
- [ ] `scripts/check-page-service-role.mjs` + `page-service-role-allowlist.mjs` — review allowlist
- [ ] `scripts/check-dropped-column-readers.ts` — update table list as schema develops
- [ ] `tests/security/cross-tenant-probe.test.ts` — update route allowlist

**Write fresh (project-specific):**
- [ ] Contract fixture files (record against your Anthropic/Stripe accounts)
- [ ] `scripts/check-auth-error-adoption.mjs` — if using the same auth pattern, copy; otherwise adapt to your error handler
- [ ] RLS policies themselves (schema-specific)
- [ ] E2E test bodies (product-specific flows)

**Skip if not applicable:**
- [ ] AI cost state machine + no-direct-AI-import ESLint rule — only if you're billing tenants for AI usage and need abuse prevention
- [ ] CruiseMapper / external data ingest checks — replace with your data source
- [ ] `PLATFORM_DEFAULT_TENANT_ID` platform-domain signup logic — only if you have a platform domain that routes to a default tenant

---

## Known Gaps (Open Issues)

These are quality processes that exist in intent but aren't fully implemented:

| Gap | Issue | What's Missing | Blocked On |
|-----|-------|----------------|------------|
| Cross-Tenant Probe (full) | #384 item 1 | Real tenant fixture setup (`setupCrossTenantFixtures()`) | #386 (dedicated test DB) |
| E2E test bodies | #384 item 3 | 28 placeholder `test.skip` specs | Product prioritization |
| Nightly test on dedicated DB | #386 | Dedicated test Supabase project | Operator provisioning |
| Contracts canary live | #473 | `STRIPE_TEST_SECRET_KEY` + `ANTHROPIC_API_KEY_TEST` GitHub secrets | Operator provisioning |
| S5852 SonarCloud false positives | #594 | 33 hotspots need manual "Safe" marking | SonarCloud UI review |

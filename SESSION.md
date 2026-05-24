# Session state — last updated 2026-05-23

## Just completed

**Spec / build prompt updates (all merged):**
- PR #82 — §33 spec addendum check-in + `.vercelignore` (with root-anchor fix)
- PR #86 — §32 Self-Service Help rewrite + index.html refresh (operator-authored rewrite that retired the automated auto-fix pipeline in favor of operator-run interactive triage via `/fix-bugs`)
- PR #87 — BP31 + BP32 build prompts updated to match the revised §32 spec

**Code work merged:**
- PR #79 — BP28 fix (dynamic `react-dom/server` import in `abuse-state-transition-notify`)
- PR #80 — BP29 §28 env-var Zod schema reconciliation + 4 runbooks + 14 meta-tests
- PR #81 — SESSION.md post-BP29
- PR #83 — BP30 Phase A: static security probes (45 tests)
- PR #84 — BP30 Phase B: skeletal fixtures + loader + db-setup scaffold + k6 + runbooks (11 tests)
- PR #85 — SESSION.md post-BP30
- PR #88 — **BP31 Phase A: §32 Self-Service Help foundation** (25 tests)
  - Migration `20260608000000_self_service_help.sql` — 4 tables + RLS
  - `lib/help-ai/pii-redaction.ts` — zero-tolerance regex (SSN/Luhn-CC/passport) + tolerable regex (emails/phones)
  - `lib/github/{auth,issues}.ts` — GitHub App installation token + createBugIssue/createFeatureIssue/closeIssue
  - `inngest/github-issue-retry.ts` — §32.7.5 exponential backoff resilience
  - `.claude/commands/fix-bugs.md` — operator-run interactive triage workflow (§32.9)
  - New lint rule `atc/no-direct-octokit-import`
  - 4 npm packages installed: @octokit/{auth-app,rest}, remark + rehype-stringify + remark-rehype + unified, docx
  - MEMORY D-065

**Test suite:** 641 passing, 42 skipped, ~1.5s wall-clock. Typecheck + lint + lint:migrations clean.

## In flight
- Nothing committed in-flight. About to start **BP31 Phase B** on a fresh branch.

## Next step
- **BP31 Phase B** — server-side wiring of the Help AI persona and routes:
  - Help AI persona registration in `lib/personas/registry.ts` with `kind='platform_help'` (bypasses tenant addendums + display-name overrides)
  - Supervisor wiring (kill switch, hallucination check, audit trail) using existing BP11 supervisor
  - 3-flow controller (`lib/help-ai/flow-controller.ts`) with explicit state machines for help / bug / feature
  - ~10 API routes under `/api/help/*` + `/api/admin/help/*`
  - Confidence/clarity scorer (§32.8) **STUBBED** per cost-deferral — returns uniform 0.5 across the 6 factors with a TODO marker pointing to the Haiku call site. Real Anthropic burn deferred until operator opts in.
  - Audit logging on session lifecycle + GitHub issue events per §32.13.3
  - Tenant isolation tests added to BP30's cross-tenant route probe
- After Phase B: **Phase C** — docs viewer, PDF/Word export, slide-over chat panel, admin triage queues.

## Blocked on user
- **GitHub App provisioning (operator task).** BP31 Phase A wired the env vars + auth + issues lib but the runtime path can't actually file issues until you create the GitHub App in the `jharvieux` org, install it on the `ATC` repo (Issues R/W only per the revised §32.7.1), and populate the 5 `GITHUB_APP_*` env vars in Vercel + local. Phase B and C don't block on this — they ship code that uses the wiring.

## Open questions

### BP31 — deferred per cost (re-enable triggers)

- **Haiku tolerable-PII redaction** (§32.7.6): regex-only today catches emails/phones but not names + obfuscated PII. Wire the Haiku call when first leaked-name-into-public-issue incident demands it.
- **Confidence/clarity scorer Haiku call** (§32.8): stubbed to return uniform 0.5 across the 6 factors in Phase B. Wire when operator wants triage prioritization signal vs the current "all submissions look equal" behavior.

### BP31 — non-cost follow-ons

- Customer bug flow (§32.10) — Phase 2 work in BP32, not in current Phase A/B/C scope
- Screenshot vision-PII detector (§32.13.2) — Phase 2 work in BP32
- `help_submission_rate` abuse dimension (§32.11) — Phase 2 work in BP32
- `/api/webhooks/github` `issues.closed` handler (§32.10.7) — Phase 2 work in BP32

### Spec-amendment follow-ups (BP29)

§28 has documented naming drift between code and spec (INTER_SERVICE_JWT_* vs SERVICE_JWT_*, RAG_SUPABASE_* vs SUPABASE_RAG_*, _PRO_ vs _PROFESSIONAL_, _SEAT_ vs _SEATS_, IMAGE_GEN_DAILY_LIMIT_PER_TENANT vs IMAGE_GEN_RATE_LIMIT_DAILY, ABUSE_AI_COST_RECOMPUTE_INTERVAL_SECONDS vs ABUSE_RECOMPUTE_CRON_SCHEDULE, forensics _PRIOR_N two-step grace vs single _PREVIOUS). Operator chose to keep code names and propose spec amendments later.

### BP30 — non-cost follow-ons

- `scripts/build-stripe-sigset.ts` — pre-generate signed webhook payload bundle for k6 `stripe-webhook-flood.js`
- `scripts/check-skipped-tests-stale.ts` — CI enforcement for the §30.10 7-day quarantine rule
- CI workflow job invoking `pnpm fixtures:load`
- CI workflow job invoking `pnpm rls:coverage` against the test DB

### BP30 — deferred entirely per cost

- AI behavior eval harness (`apps/main/evals/`, judge prompt, baseline.json, regression detection) — real Anthropic per snapshot + judge call
- Continuous-sampling cron + `ai_sampling_results` migration
- Dedicated test Supabase project (use testcontainers when needed)
- Percy/Chromatic visual regression (skip at launch per spec)

### Operator follow-ups carried forward (older BPs)

- BP28: RAG-side `current_tenant_chunks_count` reconciliation in `abuse-recompute-nightly` (`TODO(rag-service-count)` marker)
- BP27: wire counter increments + enforcement helpers into call sites; migrate 4 fetch-based AI sites
- BP27: apply migrations 20260606000000 + 20260607000000 to atc-main; confirm AI pricing values
- BP26: provision OPERATOR_SLACK_WEBHOOK_URL, NEXT_PUBLIC_SENTRY_DSN, SENTRY_DSN; refactor 5 grandfathered service-role files
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE documentation
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP25: counsel sign-off on breach notification template wording
- BP16/BP17: counsel sign-off on ICA chunk-license-survival clause + AI Liability Disclaimer

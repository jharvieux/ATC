# Session state — last updated 2026-05-23

## Just completed
- **BP28 PR #79 merged into dev** (squash) after fixing a Next.js bundler error in `abuse-state-transition-notify.ts` (dynamic `react-dom/server` import).
- **BP29 PR #80 merged into dev** (squash). §28 env-var reconciliation:
  - `docs/env-audit.md` — spec-vs-code cross-reference, naming-drift waivers
  - `apps/main/src/lib/env.ts` — +38 vars, tightened shape (ANTHROPIC required + `sk-ant-`, Stripe regex, webhook `whsec_`), conditional MS Graph superRefine, accumulated-error verifyEnvAtBoot, BACKUP_VERIFIED_AT staleness warning
  - `apps/rag/src/lib/env.ts` — +8 vars, OPENAI_EMBEDDING_DIMENSIONS `.refine(===1536)`, SERVICE_JWT_PUBLIC_KEY_PREVIOUS rotation overlap
  - `apps/main/.env.example` + `apps/rag/.env.example` — full coverage grouped by §28 subsection
  - `apps/main/test/unit/env/bp29-schema-discipline.test.ts` — 14 meta-tests (NEXT_PUBLIC_* discipline, no-pricing-in-env, .env.example parity, multi-error surfacing, ANTHROPIC shape, Apple deferred)
  - 4 runbooks: `docs/runbooks/{stripe-price-ids,secret-rotation,feature-flags}.md` + `docs/local-development.md`
  - `.github/CODEOWNERS` — env.ts + .env.example + secret-rotation routed through operator review
  - MEMORY D-062 added
- Feature branches `feature/bp28-abuse-dashboard` and `feature/bp29-env-vars` deleted (local + remote).

## In flight
- Nothing in flight — clean checkpoint on `dev`.

## Next step
- BP30 — Test infrastructure (§30): fixtures over factories, integration tests vs synthetic fixtures (PR/CI track), staging tests vs pg_dump-restored production data, RLS coverage check, cross-tenant route/Inngest probes, auth bypass probe, CVE scan, AI behavior eval harness with Claude-as-judge. Prompt source: `specs/BuildPrompts/build-prompts-part-7-prompt-30.md`.

## Blocked on user
- Nothing.

## Open questions
- Untracked / modified spec files in working tree (specs/TechSpec/index.html, section-32-self-service-help.html, build-prompts-33.md, section-33 addendum HTML/MD) are unrelated to BP28/BP29 — appears to be spec-side authoring done outside session. Left alone; commit separately when ready.
- **BP29 spec-amendment follow-up:** §28 has naming drift (INTER_SERVICE_JWT_* vs SERVICE_JWT_*, RAG_SUPABASE_* vs SUPABASE_RAG_*, _PRO_ vs _PROFESSIONAL_, _SEAT_ vs _SEATS_, IMAGE_GEN_DAILY_LIMIT_PER_TENANT vs IMAGE_GEN_RATE_LIMIT_DAILY, ABUSE_AI_COST_RECOMPUTE_INTERVAL_SECONDS vs ABUSE_RECOMPUTE_CRON_SCHEDULE, forensics _PRIOR_N two-step grace). Operator chose to keep code names and propose spec amendments later.
- BP29 deferred:
  - CI workflow does not include the new spec-required vars (ANTHROPIC_API_KEY etc.) because `verifyEnvAtBoot()` does not run during `next build`. Tests provide their own via baseEnv helpers. If CI Test step ever runs verifyEnvAtBoot at module scope, ci.yml will need `ANTHROPIC_API_KEY=sk-ant-ci-placeholder` etc.
  - Vercel env-var population for the new optional vars (RESEND_FROM_*, SENTRY_*, MICROSOFT_GRAPH_*, etc.) is operator work — defaults handle absence gracefully.
- BP28 follow-ups (deferred intentionally):
  - RAG-side `current_tenant_chunks_count` reconciliation in abuse-recompute-nightly — needs service-to-service call to RAG; `TODO(rag-service-count)` marker in code
  - BP27's counter/enforcement integration sweep (chat/email/invite/RAG call sites) still pending — BP28 scope was the operational layer only
  - In-app notifications (besides email) for state transitions — email-only for v1
- Operator follow-ups from BP27 (carried forward):
  - Apply migration 20260606000000_abuse_monitoring.sql + 20260607000000_abuse_dashboard.sql to atc-main
  - Confirm AI pricing values in lib/ai/pricing.ts when commercial agreement freezes
  - Optionally adjust the 7 BP27 env vars + 3 BP28 env vars
  - Wire counter increments + enforcement helpers into call sites
  - Migrate the 4 fetch-based AI call sites
- Operator follow-ups from BP26 (still pending):
  - Provision OPERATOR_SLACK_WEBHOOK_URL (optional)
  - Provision NEXT_PUBLIC_SENTRY_DSN + SENTRY_DSN to start shipping Sentry events
  - Optional: FORENSICS_ENCRYPTION_KEY_PRIOR_1/2 + matching _ID_PRIOR_N envs for forensics key rotation grace
  - Follow-on PR: refactor 5 grandfathered direct-service-role files (BP19 auth/groups routes)
- Operator follow-ups from earlier BPs (still pending):
  - Populate platform_settings.supervisor_slur_deny_list (BP24)
  - Populate port_info_chunks content for 17 ports (BP23)
  - Engage counsel on breach notification template wording (BP25)
  - Counsel sign-off on ICA chunk-license-survival clause (BP16) + AI Liability Disclaimer (BP17)

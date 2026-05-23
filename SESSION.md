# Session state — last updated 2026-05-23

## Just completed
- BP28 PR #79 merged into dev (squash) after fixing the Next.js bundler error in `abuse-state-transition-notify.ts` (dynamic `react-dom/server` import).
- BP29 §28 env-var reconciliation done on `feature/bp29-env-vars`:
  - `docs/env-audit.md` — spec-vs-code cross-reference, naming-drift waivers logged
  - `apps/main/src/lib/env.ts` — +38 vars, tightened ANTHROPIC/Stripe/Resend/OpenAI shape, conditional MS Graph superRefine, accumulated-error verifyEnvAtBoot, BACKUP_VERIFIED_AT staleness warning
  - `apps/rag/src/lib/env.ts` — +8 vars, OPENAI_EMBEDDING_DIMENSIONS .refine(===1536), SERVICE_JWT_PUBLIC_KEY_PREVIOUS rotation overlap
  - `apps/main/.env.example` + `apps/rag/.env.example` — full coverage grouped by §28 subsection
  - `apps/main/test/unit/env/bp29-schema-discipline.test.ts` — 14 meta-tests guarding NEXT_PUBLIC_* discipline, no-pricing-in-env, .env.example parity, multi-error surfacing
  - 4 runbooks shipped: `docs/runbooks/{stripe-price-ids,secret-rotation,feature-flags}.md` + `docs/local-development.md`
  - `.github/CODEOWNERS` — routes env.ts + .env.example + secret-rotation through operator review
  - MEMORY D-062 added
- Local verification: typecheck clean, lint clean, lint:migrations clean, 560 tests passing (16 new).

## In flight
- BP29 changes committed on `feature/bp29-env-vars` (4 commits). Next: push + open PR.

## Next step
- Push `feature/bp29-env-vars` to origin and open PR into `dev`.

## Blocked on user
- Nothing.

## Open questions
- Untracked / modified spec files in working tree (specs/TechSpec/index.html, section-32-self-service-help.html, build-prompts-33.md, section-33 addendum HTML/MD) are unrelated to BP28/BP29 — appears to be spec-side authoring done outside session. Left alone.
- **BP29 spec-amendment follow-up:** §28 has naming drift (INTER_SERVICE_JWT_* vs SERVICE_JWT_*, RAG_SUPABASE_* vs SUPABASE_RAG_*, _PRO_ vs _PROFESSIONAL_, _SEAT_ vs _SEATS_, IMAGE_GEN_DAILY_LIMIT_PER_TENANT vs IMAGE_GEN_RATE_LIMIT_DAILY, ABUSE_AI_COST_RECOMPUTE_INTERVAL_SECONDS vs ABUSE_RECOMPUTE_CRON_SCHEDULE, forensics _PRIOR_N two-step grace). Operator chose to keep code names and propose spec amendments later.
- BP29 deferred:
  - CI workflow does not include the new spec-required vars (ANTHROPIC_API_KEY etc.) because `verifyEnvAtBoot()` does not run during `next build`. Tests provide their own via baseEnv helpers. If CI Test step ever runs verifyEnvAtBoot at module scope, ci.yml will need `ANTHROPIC_API_KEY=sk-ant-ci-placeholder` etc.
  - Vercel env var population for the new optional vars (RESEND_FROM_*, SENTRY_*, MICROSOFT_GRAPH_*, etc.) is operator work — defaults handle the absence gracefully.
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

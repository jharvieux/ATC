# Session state — last updated 2026-05-23

## Just completed
- BP28 PR #79 merged into dev (squash). One follow-up commit fixed a Next.js App Router bundler error in `apps/main/src/inngest/abuse-state-transition-notify.ts` — switched to a dynamic import of `react-dom/server` to match the existing pattern in `lib/email/send-breach-notifications.ts` and `inngest/precruise-generate-and-send.ts`. All CI checks passed before merge (including RLS Snapshot Diff).
- Feature branch `feature/bp28-abuse-dashboard` deleted (local + remote).

## In flight
- Nothing in flight — clean checkpoint on `dev`. Ready to start BP29.

## Next step
- Start **BP29 — Environment variables reference (§28)**: Zod boot-time validation for main + RAG, `.env.example` parity, structured Stripe price-ID convention, secret rotation runbook.
- BP29 calls for **Sonnet 4.6**. Switch with `/model claude-sonnet-4-6` before starting.
- Create `feature/bp29-env-vars` branch off `dev`.
- Prompt source: `specs/BuildPrompts/build-prompts-part-7-prompt-29.md`.

## Blocked on user
- Model switch to Sonnet (Claude can't run `/model` itself).

## Open questions
- Untracked / modified spec files in working tree (specs/TechSpec/index.html, section-32-self-service-help.html, build-prompts-33.md, section-33 addendum HTML/MD, specs/Review/) are unrelated to BP28/BP29 — appears to be spec-side authoring done outside session. Leaving them alone; user should commit separately when ready.
- BP28 follow-ups (deferred intentionally):
  - RAG-side `current_tenant_chunks_count` reconciliation in abuse-recompute-nightly — needs service-to-service call to RAG; `TODO(rag-service-count)` marker in code
  - BP27's counter/enforcement integration sweep (chat/email/invite/RAG call sites) still pending — BP28 scope was the operational layer only
  - In-app notifications (besides email) for state transitions — email-only for v1
- Operator follow-ups from BP27 (carried forward):
  - Apply migration 20260606000000_abuse_monitoring.sql + 20260607000000_abuse_dashboard.sql to atc-main
  - Confirm AI pricing values in lib/ai/pricing.ts when commercial agreement freezes (currently illustrative)
  - Optionally adjust the 7 BP27 env vars (defaults match §27.4 percentages)
  - Optionally adjust the 3 BP28 env vars (cron schedule, override duration days, refresh seconds)
  - **Follow-on PRs deferred from BP27:**
    - Wire counter increments + enforcement helpers into call sites (chat handler post-assistant-turn, lib/email/send.ts post-send, group invite endpoints, RAG chunk lifecycle)
    - Migrate the 4 fetch-based AI call sites (customer-limit, tone-drift, forum-moderation-retry, precruise-generate-and-send)
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

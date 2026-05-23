# Session state — last updated 2026-05-23

## Just completed
- BP27: SaaS abuse monitoring + cost controls (§27) — PR #77 merged to dev
  - Migration 20260606000000_abuse_monitoring.sql: 8 new tables (tenant_usage_metrics with DATERANGE billing_period, tenant_rag_quotas, tenant_usage_overrides, usage_limit_events, tenant_rag_cap_events, ai_call_log, abuse_signals, group_invite_pending_approval) + tenant_settings.email_paused_due_to_bounce_rate + rag_submissions CHECK extension
  - lib/ai/pricing.ts: AI_PRICING_DEFAULTS (BigInt math, override via platform_settings)
  - lib/ai/call-wrapper.ts: THE only allowed importer of Anthropic + OpenAI SDKs; writes ai_call_log + UPSERTs ai_cost_cents + fires state-transition; selectModelForPurpose downgrades Sonnet→Haiku on AI-cost soft1 for non-customer-facing purposes
  - 9 SDK-import call sites migrated; BP26 lint rule tightened to call-wrapper.ts only, flipped off→error
  - lib/abuse/{revenue,thresholds,state-machine,counters,enforcement}.ts: foundation + helpers
  - BP22 RAG normalize Stage 4 updated with auto-delete (low-relevance + over-cap → review_status='auto_deleted' + tenant_rag_cap_events row); promotion bonus persistence preserved
  - 6 new Inngest functions: ai-pricing-cache-refresh (stub fetch), email-bounce-rate-monitor, quality-low-approval-signal, duplicate-high-rate-signal, 2 abuse-signal consumers (closes BP22 + BP24 TODO(part-6) hooks)
  - 3 new test files / 16 new tests; full suite 518/518
  - MEMORY D-060 with 17 decisions
- BP26 also merged earlier in same session (PR #75) with the BP20 forums-CHECK fix; SESSION.md update PR #76 in flight

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Begin BP28 — Part 6 prompt 4 (admin dashboard for abuse + cost — UI for the §27 backend that just landed). Check the BP28 file for model — likely Opus 4.7 (Part 6 is heavy on Opus).

## Blocked on user
- Nothing

## Open questions
- **RLS snapshot drift incoming.** BP27's migration may not yet be applied to staging AND the regenerated snapshot reflects only through BP26. Next PR's RLS Snapshot Diff CI check will fail until you re-apply migrations + re-run `pnpm rls:snapshot > db/rls-snapshot.sql` and commit. Same SUPABASE_DB_URL env var as before.
- Operator follow-ups from BP27 (carried forward):
  - Apply migration 20260606000000_abuse_monitoring.sql to atc-main (may already be done if you used the same DB)
  - Confirm AI pricing values in lib/ai/pricing.ts when commercial agreement freezes (currently illustrative)
  - Optionally adjust the 7 BP27 env vars (defaults match §27.4 percentages)
  - **Follow-on PRs deferred from BP27:**
    - Wire counter increments + enforcement helpers into call sites (chat handler post-assistant-turn, lib/email/send.ts post-send, group invite endpoints, RAG chunk lifecycle)
    - Migrate the 4 fetch-based AI call sites (customer-limit, tone-drift, forum-moderation-retry, precruise-generate-and-send) — wrapper needs a non-SDK fetch path or callers switch to SDK
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

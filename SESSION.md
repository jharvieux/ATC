# Session state — last updated 2026-05-23

## Just completed
- BP28: SaaS abuse dashboard + override workflow + nightly recompute (§27.7 / §27.8 / §27.11 / §27.14) — uncommitted on feature/bp28-abuse-dashboard, ready to commit/push/PR
  - Migration 20260607000000_abuse_dashboard.sql: abuse_recompute_drift_log + tenant_override_requests + tenant_usage_overrides.expiry_notified_at + platform_settings.abuse_notification_copy JSONB seed (14 keys, ON CONFLICT DO NOTHING)
  - 4 new Inngest functions: abuse-recompute-nightly (drift detection + state re-eval), billing-period-rollover (monthly), threshold-recompute-on-subscription-change (allows downgrades on exogenous tier changes), abuse-override-expiry-sweep
  - 1 new consumer: abuse-state-transition-notify (renders AbuseStateTransition email via sendTenantEmail; stamps usage_limit_events.notification_sent_to)
  - Override workflow endpoints: admin create/list/revoke + tenant request + admin queue + deny; per-tenant detail endpoint for dashboard drilldown
  - 5-tab platform admin dashboard at /admin/abuse-monitoring with [tenant_id] drilldown
  - Tenant /settings/usage page
  - 3 new env vars; 3 new admin reasons; 3 new test files (28 tests)
  - MEMORY D-061 added
  - Verified: pnpm typecheck (clean), pnpm --filter @atc/main lint (clean), migration lint (45/78), full vitest run (546 passed, 42 skipped)

## In flight
- BP28 changes uncommitted on feature/bp28-abuse-dashboard. Next steps: commit → push → open PR into dev.

## Next step
- Commit BP28 changes, push, open PR.
- Per user instruction "ignore the rls snapshot error for now", RLS Snapshot Diff CI check is expected to fail; user will handle out-of-band.

## Blocked on user
- Nothing

## Open questions
- **RLS snapshot drift still present.** Same as BP27 — staging migrations may not be applied + snapshot reflects only through earlier BP. RLS Snapshot Diff CI on the BP28 PR will fail until you re-apply migrations + re-run `pnpm rls:snapshot > db/rls-snapshot.sql` and commit. User asked to defer.
- BP28 follow-ups (deferred intentionally):
  - RAG-side `current_tenant_chunks_count` reconciliation in abuse-recompute-nightly — needs service-to-service call to RAG; TODO(rag-service-count) marker in code
  - BP27's counter/enforcement integration sweep (chat/email/invite/RAG call sites) still pending — BP28 scope was the operational layer only
  - In-app notifications (besides email) for state transitions — email-only for v1
- Operator follow-ups from BP27 (carried forward):
  - Apply migration 20260606000000_abuse_monitoring.sql (and now also 20260607000000_abuse_dashboard.sql) to atc-main
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

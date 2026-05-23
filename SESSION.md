# Session state — last updated 2026-05-23

## Just completed
- BP26: §26 four-layer auth + service-role discipline + audit_log live + forensics access + vendor health + monitoring — PR #75 merged to dev
  - Migration 20260605000000_audit_log_and_security.sql: audit_log canonical (§26.5) + partial GIN WHERE actor_type='admin', complaints, security_incidents, auth_attempts, tenant_settings.forensics_on_export
  - Sweep of 21 [audit-log:STUB] sites to real INSERTs via lib/audit/write.ts
  - withPlatformAdminAudit reconciled per §26.3a.3; platformAdminClient() ALS reader exported
  - assertPermission auth_time re-auth check (§26.3) for sensitive routes
  - Webhook context factories (Stripe + Resend) with audit-on-resolve
  - Service-role discipline: 3 new lint rules (1 error + 2 staged off until BP27 sweep) + exception flow at docs/exceptions-service-role.md
  - 5 grandfathered direct-service-role files (BP19 auth/groups); hero-image.ts refactored mid-PR
  - Inngest event registry with 20 events + validator
  - Forensics decrypt path + key-rotation grace + 90-day retention cron + legal-hold helper + manual-access runbook
  - Vendor health registry + every-minute probe + /admin/vendor-status; chat handler wired with §26.9 Anthropic fallback
  - 3 monitoring crons (auth-failure, permission-denied, cross-tenant RLS bypass) + sendOperatorAlert
  - @sentry/nextjs installed + PII-scrubbing beforeSend (5 standalone unit tests)
  - Anti-prompt-injection verification (3 tests pinning BP18 addendum delimiter integrity)
  - Runbooks: incident-response, forensics-manual-access; docs/architecture/four-layer-auth.md
  - 5 new test files, 22 new tests; all 502 tests pass
  - **Operator follow-up during PR:** RLS snapshot regenerated from atc-main (cleared accumulated drift since BP19); BP20 forums migration fix-in-place (CHECK with subquery → trigger). MEMORY D-059 + the BP20 fix commit document both.

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Begin BP27 — Part 6 prompt 3 (SaaS abuse monitoring + cost controls §27). Per build prompt: stay on Opus 4.7.

## Blocked on user
- Nothing

## Open questions
- Operator follow-ups from BP26 (carried forward):
  - Provision `OPERATOR_SLACK_WEBHOOK_URL` (optional) for operator alert fan-out
  - Provision `NEXT_PUBLIC_SENTRY_DSN` + `SENTRY_DSN` to start shipping events
  - Set `FORENSICS_ENCRYPTION_KEY_PRIOR_1/2` + matching `_ID_PRIOR_N` env vars if you intend to rotate FORENSICS_ENCRYPTION_KEY_CURRENT
  - When BP27 ships `lib/ai/call-wrapper.ts`: sweep existing direct Anthropic/OpenAI imports + flip `atc/no-direct-anthropic-or-openai-import` rule to error
  - Follow-on PR: sweep the 5 grandfathered direct-service-role files (BP19 auth/groups routes) to use createServiceRoleClient()
  - Follow-on PR: audit tenant_id-string parameters and flip `atc/no-ad-hoc-tenant-id-string` to error
- Operator follow-up from earlier BPs (still pending):
  - Populate `platform_settings.supervisor_slur_deny_list` (still empty since BP24 — content task)
  - Populate `port_info_chunks` content for 17 ports (BP23)
  - Engage counsel on breach notification template wording (BP25)
  - Counsel sign-off on ICA chunk-license-survival clause (BP16)
  - Counsel sign-off on AI Liability Disclaimer (BP17)

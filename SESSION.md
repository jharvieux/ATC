# Session state — last updated 2026-05-21

## Just completed

- BP07 — API route scaffold + Stripe webhook contract (PR #37, squash-merged to `dev`)
  - 44 route stubs (§7.1–§7.8), all through assertPermission, return 501
  - assert-permission.ts: verifies tenant resolution + active user; TODO(rbac)
  - Stripe webhook handler (§7.9a, FULL): idempotency insert, switch dispatch, row update
  - /api/inngest + stripe-webhook-incomplete-reconcile (cron */15, stalled event detection)
  - env.ts: 6 new vars (Stripe + Inngest); key names verified stable 2026
  - no-direct-service-role-import allowlist extended: webhook-handler + reconcile job
  - CI placeholders for new env vars
  - Integration tests: invalid sig → 400, duplicate → 200 + 1 row, unhandled → 200 + unhandled row
  - MEMORY.md D-042 logged

## In flight

- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step

1. **All Parts 1 & 2 build prompts are now complete (BP01–BP07).**
2. Read `specs/BuildPrompts/build-prompts-part-3.md` for the next batch of build prompts.
3. Execute the next build prompt in sequence per that file.
   - Default model: Sonnet 4.6 (switch per-prompt if a prompt specifies Opus)

## Blocked on user

- `STRIPE_TEST_SECRET_KEY` repo secret — still needed for contracts-canary nightly re-record (carry-over from D-023)
- **Manual follow-up from BP04:** Add `PLATFORM_DOMAIN_REGEX` to Vercel environment variables for `atc-main` (preview + production). Value: `^([a-z0-9-]+)\.ai-travelconcierge\.com$`
- **Platform_settings sync (D-041):** Nightly sync job + on-change webhook from main app to RAG replica not yet implemented — update RAG replica manually after any feedback knob change
- **Manual follow-up from BP07:** Add real values for `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` to Vercel environment and GitHub secrets. CI uses placeholders; live webhook tests require real values.

## Open questions

- Stripe event handlers are all TODO stubs (§14, §16 work to follow) — see D-042
- Inngest escalation is log-only (TODO(escalation) in reconcile job) — real alerts deferred to alerting infra
- Deferred FKs from BP05: contacts, personas, group_bookings tables not yet created (D-040)
- Full list of remaining §5.3 tables: contacts, contact_relationships, quotes, group_bookings, group_members, group_invitations, group_chat_threads, group_chat_messages, personas, tenant_persona_overrides, tenant_branding, host_adapters, tenant_host_configs, host_adapter_calls, escalation_topics, supervisor_alerts, audit_log, email_log, email_suppressions, legal_documents, legal_consents, platform_revenue, customer_memories, news_articles, destination_images, generated_images, pre_cruise_email_content
- `audit_log` table stub (D-036): swap `writeAuditRow` to real INSERT when §26 lands (also swap correlation_id to ULID per D-035)
- `tenantClient` Proxy: `.rpc()` not yet intercepted (D-034)
- Migration lint gate doesn't enforce GRANTs for authenticated + service_role (D-032, D-039)
- `deploy.yml` singular `VERCEL_PROJECT_ID` (atc-main only) — split deferred (D-030)
- RLS snapshot scope: §30.8 SECURITY DEFINER + GRANT coverage deferred (D-033)

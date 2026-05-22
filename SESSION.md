# Session state — last updated 2026-05-23 06:30 UTC

## Just completed

- BP11 — AI Supervisor (§10): regen budget, preflight skeleton, escalation topics, review queue, kill switch (PR #46, open, CI running)
  - 5 migrations: regen-budget columns on conversations, escalation_topics, supervisor_review_queue, supervisor sampling platform_settings seeds, ai_kill_switch_state
  - supervisor_findings already existed in messages (BP05) — migration 0016 skipped
  - 7 preflight check files: 5 stubs + promise_detection (lexical) + tone_drift (slur deny-list)
  - runSupervisor: full §10.1/§10.1a flow — kill switch, regen budget (count + token axes), slur consecutive-hit auto-escalation (threshold=3), findings persistence
  - maybeSampleForReview: probabilistic sampling per §10.5a rates from platform_settings
  - POST /api/admin/ai-kill-switch (global pause/resume) + POST /api/admin/tenant/:tenant_id/pause-ai
  - /admin/supervisor dashboard: escalations, flagged by check type, per-persona metrics
  - 25 tests: 9 promise-detection, 6 tone-drift, 10 supervisor integration — all pass, no regressions
  - MEMORY.md D-046 pending

## In flight

- PR #46 open — CI running. Merge when green.

## Next step

1. Merge PR #46 when CI passes.
2. Update SESSION.md + MEMORY.md post-merge via chore PR (same pattern as BP10).
3. Next: BP12 — Customer Memory (§11): schema, extraction job, DOB lifecycle, anon→auth transfer.
   - Model: Opus 4.7 (build prompt specifies — highest cross-tenant-leak risk in Part 3)
   - Read the BP12 section of `specs/BuildPrompts/build-prompts-part-3.md` before starting.

## Blocked on user

- **Apply pending migrations to atc-main before live traffic:**
  - BP11 new: `20260523120000_conversation_regen_budget.sql`, `20260523130000_escalation_topics.sql`, `20260523140000_supervisor_review_queue.sql`, `20260523150000_supervisor_sampling_settings.sql`, `20260523170000_ai_kill_switch.sql`
  - Still pending from BP09/BP10: `20260521190000_tenant_source_revision.sql`, `20260521200000_pending_rag_sync.sql`, `20260522100000_tenant_persona_overrides.sql`, `20260522110000_tenant_ai_mode.sql`
  - Command: `SUPABASE_DB_URL=<atc-main pooler URL> pnpm db:migrate`
- **Apply pending RAG migrations** (carry-over from BP09):
  - atc-rag: `0007_tenant_registry_shadow.sql`, `0008_retrieval_function_and_schema_fixes.sql`
  - Command: `SUPABASE_DB_URL=<atc-rag pooler URL> MIGRATIONS_DIR=apps/rag/supabase/migrations pnpm db:migrate`
- **Add ANTHROPIC_API_KEY to Vercel env vars for atc-main** (Haiku screening + supervisor)
- **Slur deny-list**: `supervisor_slur_deny_list` in platform_settings seeded empty — operator must populate before opening to tenants
- **Avatar images**: generate using prompts in `specs/Agent Backstories Photo Guide v2.docx`
- **Redis (REDIS_URL)** — provision Upstash; add to Vercel env vars for atc-rag and `.env.local`
- **Vercel env vars to add** (atc-rag): `OPENAI_API_KEY`, `SUPABASE_RAG_ANON_KEY`, plus all BP08 vars
- `STRIPE_TEST_SECRET_KEY` repo secret — carry-over from D-023
- `PLATFORM_DOMAIN_REGEX` Vercel env var for atc-main — carry-over from BP04

## Open questions

- Sampling rates use spec defaults (1%/10%/25%) — tune downward after first week of production observation (D-046)
- Five "real" preflight checks are stubs (hallucination_risk, persona_drift, arithmetic_check, compliance_keyword, topic_escalation heuristic) — pending Part 5 §21.10 (D-046)
- Slur deny-list empty at launch — operator must populate before tenants go live (D-046)
- Supervisor dashboard service-role import in ESLint allowlist — TODO(§26): replace with withPlatformAdminAudit once admin session auth lands
- Haiku screening prompt in screen-addendum.ts is first-draft (D-045)
- §6-weighting-formula in match_knowledge_chunks() — equal weights until spec finalised (D-044)
- §22.4-haiku-redaction in /api/ingest — tolerable PII pass deferred (D-044)
- Stripe event handlers are all TODO stubs (§14, §16 work) — D-042
- platform_settings sync (D-041) — replica updated manually until sync lands
- Deferred FKs from BP05: contacts, personas, group_bookings — D-040
- audit_log stub → real INSERT when §26 lands (D-036)
- tenantClient Proxy: .rpc() not intercepted (D-034)
- deploy.yml: singular VERCEL_PROJECT_ID (atc-main only) — D-030

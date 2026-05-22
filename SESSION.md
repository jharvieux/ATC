# Session state — last updated 2026-05-22 12:00 UTC

## Just completed

- BP12 — Customer Memory (§11): schema, extraction job, DOB lifecycle, anon→auth transfer (PR #48, open, CI running)
  - 2 migrations: customer_memories (full RLS, awaiting_dob_reprompt, UNIQUE tenant+user) + anonymous_sessions stub + transfer columns
  - tenantContextFromInngestEvent: implemented (was a stub throwing "not implemented")
  - inngest/events.ts: 3 event types created
  - extract-memory.ts: full §11.2 flow — opt-out before debounce, §11.2.2 defense-in-depth assertion, Haiku + Zod validation, mergeMemory, optimistic-lock with re-enqueue
  - lib/memory/merge.ts: loyalty programs union by program_code, JSONB shallow-merge
  - lib/memory/dob.ts: isEstimatedDOBOverdue, suppressDOBContentForEstimated
  - dob-estimate-reprompt-eligible.ts: nightly cron
  - lib/transfer/anon-to-auth.ts: softCommitTransfer + undoTransfer
  - lib/transfer/deferred-processing-guard.ts: assertNotInDeferredWindow
  - transfer-finalize.ts: no-op-flag undo cancellation approach
  - Memory controls API: GET/PATCH/DELETE /api/memory + POST /api/memory/opt-out
  - Transfer consent UI + UndoBanner component
  - 21 new tests: 6 merge unit, 8 extraction integration, 7 transfer integration — 117 total, 0 regressions
  - MEMORY.md D-047 added

## In flight

- PR #48 open — CI running. Merge when green.

## Next step

1. Merge PR #48 when CI passes.
2. Update SESSION.md + MEMORY.md post-merge via chore PR (same pattern as BP11).
3. Next: BP13 — CRM (§12): contacts, relationships, pipeline stages, quotes, host-booking-fee configs, commission worked-example fixtures.
   - Model: Sonnet 4.6 (no Opus required for BP13)
   - Read the BP13 section of `specs/BuildPrompts/build-prompts-part-3.md` before starting.

## Blocked on user

- **Apply pending migrations to atc-main before live traffic:**
  - BP12 new: `20260523180000_customer_memories.sql`, `20260523190000_anonymous_sessions_transfer.sql`
  - BP11 new: `20260523120000_conversation_regen_budget.sql`, `20260523130000_escalation_topics.sql`, `20260523140000_supervisor_review_queue.sql`, `20260523150000_supervisor_sampling_settings.sql`, `20260523170000_ai_kill_switch.sql`
  - Still pending from BP09/BP10: `20260521190000_tenant_source_revision.sql`, `20260521200000_pending_rag_sync.sql`, `20260522100000_tenant_persona_overrides.sql`, `20260522110000_tenant_ai_mode.sql`
  - Command: `SUPABASE_DB_URL=<atc-main pooler URL> pnpm db:migrate`
- **Apply pending RAG migrations** (carry-over from BP09):
  - atc-rag: `0007_tenant_registry_shadow.sql`, `0008_retrieval_function_and_schema_fixes.sql`
  - Command: `SUPABASE_DB_URL=<atc-rag pooler URL> MIGRATIONS_DIR=apps/rag/supabase/migrations pnpm db:migrate`
- **Add ANTHROPIC_API_KEY to Vercel env vars for atc-main** (Haiku screening + supervisor + memory extraction)
- **Slur deny-list**: `supervisor_slur_deny_list` in platform_settings seeded empty — operator must populate before opening to tenants
- **Avatar images**: generate using prompts in `specs/Agent Backstories Photo Guide v2.docx`
- **Redis (REDIS_URL)** — provision Upstash; add to Vercel env vars for atc-rag and `.env.local`
- **Vercel env vars to add** (atc-rag): `OPENAI_API_KEY`, `SUPABASE_RAG_ANON_KEY`, plus all BP08 vars
- `STRIPE_TEST_SECRET_KEY` repo secret — carry-over from D-023
- `PLATFORM_DOMAIN_REGEX` Vercel env var for atc-main — carry-over from BP04

## Open questions

- Transfer undo cancellation uses no-op-flag approach (finalize function re-reads on arrival). If Inngest invocation cost is a concern after scale, consider `cancelOn` machinery — deferred (D-047)
- `anonymous_sessions.anonymous_session_id` FK on `conversations` and `messages` — the transfer re-key currently filters by `anonymous_session_id` on those tables; that column may not exist yet (depends on when auth work lands). The re-key in `anon-to-auth.ts` has a graceful fallback for missing columns (D-047)
- DOB re-prompt persona instruction — lives in buildSystemPrompt but needs the chat handler fully wired (Part 5 §21) before it fires at runtime
- contacts FK on customer_memories.contact_id and conversations.contact_id — pending Prompt 13
- Inngest typed client deferred (D-047)
- Sampling rates use spec defaults — tune downward after first week (D-046)
- Five supervisor preflight checks are stubs — pending Part 5 §21.10 (D-046)
- Slur deny-list empty at launch (D-046)
- Supervisor dashboard service-role import in ESLint allowlist — TODO(§26) (D-046)
- Haiku screening prompt is first-draft (D-045)
- §6-weighting-formula in match_knowledge_chunks() — equal weights until spec finalised (D-044)
- §22.4-haiku-redaction in /api/ingest — tolerable PII pass deferred (D-044)
- Stripe event handlers are all TODO stubs (§14, §16 work) — D-042
- platform_settings sync (D-041) — replica updated manually until sync lands
- Deferred FKs from BP05: contacts, personas, group_bookings — D-040
- audit_log stub → real INSERT when §26 lands (D-036)
- tenantClient Proxy: .rpc() not intercepted (D-034)
- deploy.yml: singular VERCEL_PROJECT_ID (atc-main only) — D-030

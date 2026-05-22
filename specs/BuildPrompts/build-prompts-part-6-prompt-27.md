# Build Prompts — Spec v6.2, Part 6 (continued)

**This file contains Build Prompt 27 only.** Prompts 25 and 26 were in prior files; Prompt 28 follows in the next file.

-----

# BUILD PROMPT 27 — Five-dimension abuse monitoring: schema, thresholds, enforcement

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** This prompt builds the real-money cost-control backbone. The AI cost dimension thresholds sit BELOW subscription revenue at all tiers (30/50/70%) — getting the revenue computation wrong (mixed-up base seat price vs additional seat price, wrong ladder band, monthly-vs-annual confusion) lets a tenant burn money the platform was supposed to be earning. The §27.4.2 RAG-cap-with-promotion-rewards model is structurally unique among the five dimensions — total cap, not monthly velocity; promotion bonus is permanent and persists after promoted chunk removal; auto-deletion at over-cap is the enforcement mechanism (no hard cutoff tier). The threshold-computation has six interacting inputs (tier, seat count, billing period, base allocation, promoted-chunks bonus, override) and every dimension follows the same multi-seat × billing-period multiplier — a bug in the multiplier formula multiplies across all five dimensions. The enforcement behaviors per dimension are non-uniform (chat throttle vs RAG auto-delete vs email queue vs group invitation pre-approval); getting one wrong is a UX problem with money attached.

**Spec references:** Part 6 §27.1 (why), §27.2 (five dimensions), §27.3 (three-tier limit structure), §27.4 (thresholds by dimension — §27.4.1 AI cost, §27.4.2 RAG submissions, §27.4.3 chat volume, §27.4.4 email volume, §27.4.5 group invitations), §27.5 (schema — four new tables), §27.6 (enforcement behavior by dimension), §27.12 (cost attribution), §27.13 (integration with existing sections). Depends on Part 1 Prompt 03 (`tier_definitions`), Part 4 Prompt 16 (subscription state — `tier_id`, `seat_count`, `billing_period`), Part 4 Prompt 15 (commissions for revenue baseline), Part 5 Prompts 22 + 24 (the abuse-signal event emissions to be consumed), Build Prompt 26 (the lint rule against direct Anthropic/OpenAI imports is already registered; this prompt creates the `apps/main/src/lib/ai/call-wrapper.ts` file that the rule allowlists).

**Prerequisite check:** Build Prompts 01–26 are committed. Tier definitions table has the seat-ladder pricing per §3.3.

**Goal:** Build the schema (four spec tables + `ai_call_log` + `abuse_signals`), the daily AI pricing catalog with the instrumented call wrapper, the threshold-resolution function (one source of truth for all five dimensions), the real-time event-driven counter increments, the monotonic state-machine, and the enforcement-behavior layer per dimension. Stop short of the recompute crons, notification flow, override workflow, and admin/tenant UI — those are Build Prompt 28.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   
   ```
   ANTHROPIC_DAILY_PRICING_CACHE_TTL_HOURS (default 24)
   OPENAI_DAILY_PRICING_CACHE_TTL_HOURS (default 24)
   ABUSE_AI_COST_SOFT1_PERCENT (default 30)
   ABUSE_AI_COST_SOFT2_PERCENT (default 50)
   ABUSE_AI_COST_HARD_PERCENT (default 70)
   ABUSE_RAG_APPROACHING_PERCENT (default 85)
   ABUSE_EMAIL_BOUNCE_RATE_THRESHOLD_PERCENT (default 5)
   ```
1. **Schema — six new tables.** Migration `apps/main/supabase/migrations/0028_abuse_monitoring.sql` per §27.5:
- `public.tenant_usage_metrics` exactly per §27.5 schema. Composite UNIQUE on `(tenant_id, billing_period)` — `billing_period` is a TEXT field formatted `YYYY-MM` (calendar month).
- `public.tenant_rag_quotas` exactly per §27.5 schema. PK on `tenant_id`.
- `public.tenant_usage_overrides` exactly per §27.5 schema.
- `public.usage_limit_events` exactly per §27.5 schema.
- `public.tenant_rag_cap_events` exactly per §27.5 schema.
- **Per-call AI cost log:** `public.ai_call_log` per §27.12:
  - `id UUID PK`
  - `tenant_id UUID NOT NULL REFERENCES tenants(id)`
  - `conversation_id UUID REFERENCES conversations(id)` (nullable for non-conversation calls)
  - `user_id UUID REFERENCES users(id)` (nullable for system-initiated calls)
  - `model TEXT NOT NULL`
  - `vendor TEXT NOT NULL CHECK (vendor IN ('anthropic','openai'))`
  - `purpose TEXT NOT NULL CHECK (purpose IN ('chat_main','chat_supervisor','entity_extraction','memory_extraction','rag_normalization','rag_pii_redaction','rag_relevance_scoring','persona_addendum_screen','forum_moderation','precruise_generation','quote_narrative','embedding','content_normalization','other'))`
  - `input_tokens INTEGER NOT NULL`
  - `output_tokens INTEGER NOT NULL`
  - `cost_estimate_cents BIGINT NOT NULL`
  - `latency_ms INTEGER`
  - `created_at TIMESTAMPTZ DEFAULT NOW()`
- **Abuse signals table** (for Part 5 prompts 22/24 events): `public.abuse_signals`:
  - `id UUID PK`
  - `tenant_id UUID NOT NULL REFERENCES tenants(id)`
  - `signal_kind TEXT NOT NULL CHECK (signal_kind IN ('rag_pii_recurring','anon_chat_burst','quality_low_approval','duplicate_high_rate','email_bounce_rate'))`
  - `detail JSONB NOT NULL`
  - `created_at TIMESTAMPTZ DEFAULT NOW()`
  - `acknowledged_at TIMESTAMPTZ`
  - `acknowledged_by_user_id UUID REFERENCES users(id)`
- Indexes:
  - `tenant_usage_metrics (tenant_id, billing_period)` (already in UNIQUE constraint)
  - `usage_limit_events (tenant_id, triggered_at DESC)`
  - `tenant_rag_cap_events (tenant_id, occurred_at DESC)`
  - `ai_call_log (tenant_id, created_at DESC)`
  - `ai_call_log (created_at)` for cross-tenant analysis windows
  - Partial index on `tenant_usage_overrides` WHERE `effective_to IS NULL OR effective_to > CURRENT_DATE`
  - `abuse_signals (tenant_id, created_at DESC)` partial WHERE `acknowledged_at IS NULL` for the admin queue
- RLS:
  - `tenant_usage_metrics` and `tenant_rag_quotas`: tenant-scoped reads via the `tenant_admin` role (tenants see their own usage).
  - `tenant_usage_overrides`, `usage_limit_events`, `tenant_rag_cap_events`, `ai_call_log`, `abuse_signals`: service-role-only.
1. **AI pricing catalog — §27.12.** Build `apps/main/src/lib/ai/pricing.ts`:
- Static export of current pricing as typed structure (numbers are illustrative — operator confirms before commit; document source URL and date in a comment):
  
  ```typescript
  export const AI_PRICING_DEFAULTS: Record<string, { input_per_million_cents: number; output_per_million_cents: number }> = {
    'claude-opus-4-7': { input_per_million_cents: 150000, output_per_million_cents: 750000 },
    'claude-sonnet-4-6': { input_per_million_cents: 30000, output_per_million_cents: 150000 },
    'claude-haiku-4-5-20251001': { input_per_million_cents: 8000, output_per_million_cents: 40000 },
    'text-embedding-3-small': { input_per_million_cents: 200, output_per_million_cents: 0 },
    'text-embedding-3-large': { input_per_million_cents: 1300, output_per_million_cents: 0 },
    'gpt-4o-mini': { input_per_million_cents: 15000, output_per_million_cents: 60000 },
  };
  ```
  
  Values are per-million-input/output tokens, in cents. Comment block with source links + last-confirmed date.
- `getCostEstimate({ model, input_tokens, output_tokens }): bigint` — returns cents. Reads from `platform_settings.ai_pricing_catalog` JSONB if present (operator-overridable), falling back to `AI_PRICING_DEFAULTS`. Use BigInt math to avoid floating-point drift on small per-call amounts.
- **Auto-refresh path:** Inngest scheduled function `ai-pricing-cache-refresh` running daily reads `platform_settings.ai_pricing_last_refreshed_at`; if > 24h, ATTEMPTS to fetch Anthropic + OpenAI pricing pages and update the JSONB. **The auto-fetch parsers are `// TODO(operator)` — pricing pages change format.** Ship the cron skeleton with `console.warn('pricing fetch not implemented; using configured defaults')` and have the cron just update the `last_refreshed_at` timestamp without changing values. Operator updates `AI_PRICING_DEFAULTS` in source OR `platform_settings.ai_pricing_catalog` JSONB as needed.
1. **Instrumented AI call wrapper — §27.12.** Build `apps/main/src/lib/ai/call-wrapper.ts`:
- This is THE file the Prompt 26 lint rule whitelists for direct Anthropic/OpenAI imports. All other call sites in the codebase import from here.
- `instrumentedClaudeCall(args: { tenant_id: string; conversation_id?: string; user_id?: string; model: string; purpose: AICallPurpose; messages: ClaudeMessages; ...otherClaudeArgs }): Promise<ClaudeResponse>`:
  - Records `start = Date.now()`.
  - Calls Anthropic SDK with the message params.
  - On response: reads `usage.input_tokens` and `usage.output_tokens`; computes `cost_estimate_cents = getCostEstimate(...)`.
  - Inserts an `ai_call_log` row with the full attribution.
  - UPSERTs `tenant_usage_metrics` row for `(tenant_id, current_billing_period())` incrementing `ai_cost_cents` by the new charge. Current billing period is `YYYY-MM` of the tenant’s `billing_period_anchor` (tenants on monthly billing align to calendar month; tenants on annual still report monthly metrics for visibility).
  - After increment: call `checkStateTransitionIfNeeded(tenant_id, 'ai_cost')` (Task 8).
  - Returns the response.
- `instrumentedOpenAICall` — same shape for embeddings + any other OpenAI usage.
- **Migrate every existing call site.** The earlier prompts (09, 10, 11, 12, 13, 18, 20, 21, 22, 23, 24) all call Anthropic and/or OpenAI directly. Walk through each file under `apps/main/src/` that imports `@anthropic-ai/sdk` or `openai` and replace the direct call with the instrumented wrapper. The `purpose` argument distinguishes attribution per §27.12:
  - **Memory extraction:** the tenant whose customer’s memory is being extracted; `purpose='memory_extraction'`.
  - **RAG normalization (Prompt 22 stage 3):** the submitting tenant; `purpose='rag_normalization'`.
  - **RAG PII redaction (Prompt 22 stage 2):** the submitting tenant; `purpose='rag_pii_redaction'`.
  - **Pre-cruise generation (Prompt 23):** the tenant whose customer is receiving; `purpose='precruise_generation'`.
  - **Persona addendum screen (Prompt 18):** the tenant who submitted the addendum; `purpose='persona_addendum_screen'`.
  - **Forum moderation (Prompt 20):** the tenant who owns the forum; `purpose='forum_moderation'`.
  - **Quote narrative (Prompt 21):** the tenant who owns the booking; `purpose='quote_narrative'`.
  - **Entity extraction (Prompt 21):** the tenant whose customer is chatting; `purpose='entity_extraction'`.
  - **Supervisor preflight (Prompt 11):** same; `purpose='chat_supervisor'`.
  - **Main chat (Prompt 10):** the tenant the customer is interacting with; `purpose='chat_main'`.
  - **Embeddings (Prompt 09, RAG side):** the tenant whose chunk is being embedded; `purpose='embedding'`.
- Confirm the Prompt 26 lint rule `no-direct-anthropic-or-openai-import` allows ONLY `apps/main/src/lib/ai/call-wrapper.ts`. Tighten the rule’s allowlist now that the file exists.
1. **Effective monthly revenue computation — §27.4.1.** Build `apps/main/src/lib/abuse/revenue.ts`:
- `computeEffectiveMonthlyRevenue(tenant: { tier_id, seat_count, billing_period }): bigint` — returns cents.
- Steps:
  - Look up `tier_definitions.base_seat_monthly_cents` for the tier.
  - For Agency tier with `seat_count > 1`: walk the seat ladder per §3.3 — first additional seat at $59/mo (seats 2–3), then $49/mo (seats 4–10), then $39/mo (seats 11+). Sum per-band counts. The ladder values live in `platform_settings.seat_ladder` JSONB; if absent, hardcode per §3.3 with a `// TODO(verify)` and an MEMORY entry.
  - Total monthly revenue = base + sum of additional-seat ladder amounts.
  - For annual billing: divide annual price by 12. For BYO tiers: same logic against BYO base prices.
- Test the function exhaustively against the §27.4.1 worked examples:
  - Single-seat monthly Sub-Host Agency = $249 (24900 cents).
  - 6-user annual Sub-Host Agency: annual = ($249 × 10) base annual + 5 additional seats per ladder annual rate; divided by 12 ≈ $436.67 per the spec’s worked example (43667 cents). Match to within $1 (cents-rounding may differ).
- Document a single canonical sentence about the revenue formula in MEMORY so reviewers later don’t reverse-engineer.
1. **Threshold resolution — the single source of truth.** Build `apps/main/src/lib/abuse/thresholds.ts`:
- `resolveThresholds(tenant: TenantSnapshot, promoted_chunks_count: number): ResolvedThresholds`:
  - Returns an object with all five dimensions:
    
    ```typescript
    {
      ai_cost_cents: { soft1, soft2, hard },
      chat_volume_messages_monthly: { soft1, soft2, hard },
      email_volume_daily: { soft1, soft2, hard },
      group_invite_monthly: { soft1, soft2, hard, per_group_max: 100 },
      rag_cap_total: { base, effective, approaching }
    }
    ```
  - **AI cost:** `effective_monthly_revenue × {30, 50, 70}%`. Rounded to nearest cent.
  - **Chat volume:** read `tier_definitions.chat_volume_base_monthly` for the tier (seed values per §27.4.3 if not present). Multiply by `effective_monthly_revenue ÷ tier_reference_revenue` (the reference = single-seat-monthly price for the tier). For multi-seat or annual tenants, the multiplier > 1.
  - **Email volume (daily):** same shape, base per §27.4.4 table.
  - **Group invite (monthly):** base allocations per §27.4.5 (uniform 500 / 1000 / 2000 by tier; per-group max 100 invitees independent of monthly cap).
  - **RAG cap:** `base = tier_definitions.rag_chunks_base × revenue_multiplier`; `effective = base + (25 × promoted_chunks_count)`; `approaching = floor(effective × 0.85)`.
  - **Override application:** Query `tenant_usage_overrides` for any rows with `tenant_id = tenant.id AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`. For each row matching dimension + tier (soft1/soft2/hard/etc.): replace the computed threshold for that dimension+tier. **Precedence:** override > computed. Document this rule in MEMORY.
- This function is the single source of truth for all five dimensions. Any future cap logic change goes here, not at call sites.
1. **Real-time event-driven counter increments — §27.7.** Wire counters at every relevant event:
- **AI call:** `instrumentedClaudeCall` from Task 4 already increments `tenant_usage_metrics.ai_cost_cents` via UPSERT.
- **Chat message (customer-facing):** when a customer-facing assistant turn completes streaming, increment `tenant_usage_metrics.chat_messages_count` for `(tenant_id, current_billing_period)`. Hook into the chat handler from Prompt 24.
- **Email send:** the existing `sendEmail` helper from Prompt 23 increments `tenant_usage_metrics.email_sent_count` AND `email_sent_today`. Reset `email_sent_today` to 0 (and update `email_sent_today_anchor`) when the day flips. Use a stored procedure or a transaction: `IF email_sent_today_anchor < CURRENT_DATE THEN reset; END IF; UPDATE ...`.
- **Group invitation send:** the existing send path from Prompt 19 increments `tenant_usage_metrics.group_invitees_count`.
- **RAG submission counts:**
  - On tenant-scoped chunk creation: increment `tenant_rag_quotas.current_tenant_chunks_count`.
  - On promotion to global: increment `tenant_rag_quotas.promoted_chunks_count`.
  - On chunk deletion: decrement `tenant_rag_quotas.current_tenant_chunks_count`.
  - Per §27.7 “Every chunk deletion decrements current_tenant_chunks_count.” Verify the Prompt 22 chunk deletion paths emit this decrement.
- All increments use `UPSERT` on `(tenant_id, billing_period)` so concurrent calls don’t race-create duplicate rows.
1. **State-transition function — monotonic per billing period.** Build `apps/main/src/lib/abuse/state-machine.ts`:
- `checkStateTransitionIfNeeded(tenant_id: string, dimension: AbuseDimension): Promise<void>`:
  - Read current metric value from `tenant_usage_metrics` (or `tenant_rag_quotas` for RAG).
  - Call `resolveThresholds(tenant, promoted_chunks_count)` to get current thresholds.
  - Compute new state: `ok` if below soft1; `soft1` if ≥ soft1 < soft2; `soft2` if ≥ soft2 < hard; `hard` if ≥ hard.
  - Read current state column from the row (e.g., `tenant_usage_metrics.ai_cost_limit_state` for AI cost).
  - **Monotonic rule:** state CAN move ok → soft1 → soft2 → hard within a billing_period. Cannot move backward (usage dropping below soft2 doesn’t move from soft2 back to soft1 within the same billing period). Implementation: only update if `new_rank > current_rank`.
  - If new_rank > current_rank:
    - Insert `usage_limit_events` row capturing the transition.
    - UPDATE the state column.
    - Emit Inngest event `abuse.state_transition` with `{ tenant_id, dimension, from_state, to_state, metric_value, threshold_crossed }`. Prompt 28 owns the notification consumer.
- **RAG state is NOT monotonic** — `tenant_rag_quotas.rag_state` reflects current standing. A tenant who deletes chunks drops back to `ok` immediately. The same function handles this with a flag: `monotonic=true` for the four monthly-cycling dimensions, `monotonic=false` for `rag_cap`.
1. **Enforcement behaviors per dimension — §27.6.** Build `apps/main/src/lib/abuse/enforcement.ts`:
- `getEnforcementMode(tenant_id, dimension): Promise<EnforcementMode>` returns the current state.
- `applyEnforcement({ tenant_id, dimension, state })` is the side-effect-bearing call at the enforcement point.
   
   **AI cost enforcement:**
- **soft1:** the persona-prompt builder (from Prompt 10) reads `ai_cost_limit_state`; if `soft1` or higher, swap eligible Sonnet calls to Haiku for non-customer-facing turns (entity extraction, supervisor preflight, normalization). Cap conversation memory size injected into prompts to a tighter limit (e.g., last 5 turns instead of last 10). Implement via a `selectModelForPurpose({ purpose, ai_cost_state })` helper that the prompt builder calls.
- **soft2:** above + reduce RAG top-k from 4 to 2; cap response length via Claude’s `max_tokens` parameter to a tighter limit.
- **hard:** chat handler returns the §27.6 fallback message; do NOT call Claude. Existing conversations remain readable (no rewriting of history). Add the fallback message to `platform_settings.chat_ai_cost_hard_fallback_message` with a default per §27.6.
   
   **Chat volume enforcement:**
- **soft1:** insert 2–3s artificial delay before AI response.
- **soft2:** longer delay (5–8s); serve a “we’re experiencing high load” variant on top of the normal response.
- **hard:** same fallback as AI cost hard.
   
   **Email volume enforcement:**
- **soft1:** queue email send with 5-minute delay (Inngest delayed job).
- **soft2:** 30-minute delay.
- **hard:** non-transactional sends refused (return suppressed=`'rate_limit_email_volume_hard'`); transactional emails (booking confirmations, password resets, etc.) still go through; tenant banner shown via Part 5 Prompt 23 notifications path.
- **Bounce-rate side channel — §27.4.4:** Inngest cron `email-bounce-rate-monitor` running every 6 hours; for each tenant compute bounce-rate over rolling 24h = `(bounces / sent) × 100`. If > `ABUSE_EMAIL_BOUNCE_RATE_THRESHOLD_PERCENT` (default 5): write an `abuse_signals` row with `signal_kind='email_bounce_rate'`, AND pause non-transactional sends regardless of monthly volume state (set a `tenant_settings.email_paused_due_to_bounce_rate BOOLEAN`). This pause is INDEPENDENT of the monthly state machine — it’s an immediate side channel. Resolution: when the rolling 24h bounce-rate drops back below threshold, the cron lifts the pause.
   
   **Group invite enforcement:**
- **soft1:** the group invite send endpoint requires explicit `confirm: true` in the body per batch when state is `soft1`. UI surfaces this as a “Send Now” confirmation modal.
- **soft2:** batches > 20 require platform-admin pre-approval. Build a queue: `group_invite_pending_approval` table (created in this migration: `id UUID PK, group_id, requested_by_user_id, invitee_count, requested_at, status CHECK IN ('pending','approved','denied'), reviewed_by, reviewed_at`). Inserts replace immediate send. The admin acts via a queue UI (built in Prompt 28).
- **hard:** no new invitations until next month; existing groups continue. The send endpoint returns 429 with `reason='group_invite_monthly_hard'`.
   
   **RAG cap enforcement:**
- **approaching (85%):** banner to tenant in `/tenant-admin/rag/queue` suggesting promotion-worthy submissions. Read on demand; no event needed.
- **at_cap (100%):** banner + email; new low-relevance submissions auto-deleted at submit time (see Task 10).
- **over_cap (e.g., chunk count temporarily exceeds cap):** same as at_cap.
1. **RAG submission landing logic — §27.4.2.** Update the Prompt 22 normalization Stage 4 (auto-flag) to use the new state machine:
- After Haiku assigns relevance score:
  - If `relevance_score >= 0.6`: queued for admin global review; does NOT count against cap while pending. The cap counts only chunks that ARE actually in the corpus (tenant-scoped) or PROMOTED (global). Pending-review items are in limbo.
  - If `relevance_score < 0.6` AND `current_tenant_chunks_count < effective_cap`: approved as tenant-specific chunk; increment `current_tenant_chunks_count`. Standard tenant review queue applies.
  - If `relevance_score < 0.6` AND `current_tenant_chunks_count >= effective_cap`:
    - **Auto-delete the submission.** The submission row goes to `review_status='auto_deleted'` (extend the CHECK if needed); the chunk is NOT created.
    - User sees an inline message in the submission UI: “Your knowledge base is at capacity. Submit content that’s broadly useful to earn more — each chunk promoted to platform-wide knowledge adds 25 slots permanently.”
    - Write `tenant_rag_cap_events` row with `event_type='submission_auto_deleted'`, `detail = { submission_id, relevance_score, current_count, effective_cap }`.
- When admin reviews a queue-eligible item (Prompt 22 promotion mechanics):
  - **Promoted:** `tenant_rag_quotas.promoted_chunks_count++`; recompute state (RAG state non-monotonic — could drop back from over_cap to ok if the cap raise crosses below current count).
  - **Declined (not promoted):** falls back to tenant-specific scope check (same rule as above — counts against cap; if over, auto-delete).
- **Promotion bonus persistence — §27.4.2 critical detail:** when admin DEMOTES a previously-promoted chunk (via Prompt 22 demote path), `promoted_chunks_count` does NOT decrement. The bonus persists per §27.4.2. The demoted chunk’s fate (tenant-scoped or hard-deleted) is separate; the cap bonus stays. Document this in MEMORY as the single most surprising rule in §27.
1. **Cost attribution per §27.12 — call-site audit.** Walk every Claude / OpenAI call site in the codebase. For each:
- Confirm the right `tenant_id` is attributed per the §27.12 rules in Task 4.
- Confirm the right `purpose` enum value.
- Confirm the `conversation_id` and `user_id` are propagated when applicable.
- Document the audit results in MEMORY: list every call site, the attribution, and any ambiguous cases.
- **Ambiguous cases per §27.12 “Some shared overhead is amortized”:** if a call’s tenant is unclear (e.g., a platform-level cron generating embeddings for the global RAG corpus), attribute to a synthetic `PLATFORM_TENANT_ID` constant. Document this constant in MEMORY.
1. **Consume the abuse-signal events from Part 5 — §27.10 dashboard signals.** The events emitted by Prompts 22 (`tenant.rag_pii_recurring_pattern_detected`) and 24 (`chat.anonymous_chat_burst_detected`) are ALERT-ONLY — they do NOT directly throttle. Wire consumers:
- Inngest function `abuse-signal-consumer-rag-pii-recurring` listens for `tenant.rag_pii_recurring_pattern_detected`; writes a row to `abuse_signals` with `signal_kind='rag_pii_recurring'`, `detail = event payload`. (The Prompt 22 event name spec uses `tenant.rag_pii_recurring_pattern_detected`; verify and reconcile if the actual emitter named it differently — document in MEMORY.)
- Inngest function `abuse-signal-consumer-anon-chat-burst` listens for `chat.anonymous_chat_burst_detected`; writes `abuse_signals` row with `signal_kind='anon_chat_burst'`.
- Plus: a periodic `quality-low-approval-signal-cron` running daily that computes per-tenant tenant-review approval rate over rolling 30 days; if < 50% AND > 20 submissions in the window: write `abuse_signals` row with `signal_kind='quality_low_approval'`.
- Plus: `duplicate-high-rate-signal-cron` running daily; if > 30% of submissions in last 30 days are duplicates (per Prompt 22 duplicate detection): write `abuse_signals` row with `signal_kind='duplicate_high_rate'`.
- The §27.10 admin dashboard surfaces these alongside the state-transition data (Prompt 28 owns the UI).
1. **Tests.**
- **Revenue computation:**
  - Single-seat monthly Sub-Host Agency → 24900 cents ($249).
  - 6-user annual Sub-Host Agency → ~43667 cents (within $1 of spec worked example).
  - Single-seat monthly Sub-Host Pro → matches `tier_definitions` value.
  - Single-seat monthly Sub-Host Starter → matches.
  - 4-user monthly Sub-Host Agency → base + 2 seats @ $59 + 1 seat @ $49 = $249 + $118 + $49 = $416 monthly = 41600 cents.
- **AI cost thresholds:**
  - Sub-Host Pro single-seat monthly → soft1, soft2, hard match §27.4.1 illustrative table values.
  - 6-user annual Sub-Host Agency → multiplier ~1.75 × base allocations.
- **Chat volume thresholds:**
  - Match §27.4.3 worked examples within ±1 message.
- **RAG cap:**
  - Sub-Host Pro single-seat with 3 promoted chunks → effective cap = base + 75.
  - Same tenant after admin demotes 1 of those 3 promoted chunks → effective cap STILL = base + 75 (bonus persists per §27.4.2).
- **Override application:**
  - Override row `dimension='ai_cost', tier_override='hard', threshold_value=15000` for a tenant whose computed hard is 10430 → resolved hard = 15000.
  - Override with `effective_to` in the past → ignored; computed value used.
- **Monotonic state:**
  - Tenant at soft1 (ai_cost=45000) sees usage drop to 30000 → state STAYS at soft1; does not revert.
  - Same tenant rolls over to next billing period → new row has state=‘ok’ fresh.
- **RAG state non-monotonic:**
  - Tenant at `at_cap` deletes chunks until under cap → state recomputes to `ok` immediately.
- **AI call instrumentation:**
  - Mocked Claude call via `instrumentedClaudeCall` writes one `ai_call_log` row AND increments `tenant_usage_metrics.ai_cost_cents` by the computed value.
  - Wrong `purpose` enum value rejected at function call (type system).
- **AI cost soft1 enforcement:**
  - In soft1 state, `selectModelForPurpose({ purpose: 'chat_supervisor' })` returns Haiku (not Sonnet).
  - In soft1 state, `purpose: 'chat_main'` still returns the configured customer-facing model (NOT downgraded — soft1 only swaps non-customer-facing).
- **AI cost hard enforcement:**
  - In hard state, the chat handler returns the fallback message without calling Claude. Verify the mock Claude was not called.
- **Email bounce-rate side channel:**
  - Simulated 6% bounce rate over 24h: an `abuse_signals` row is written, `tenant_settings.email_paused_due_to_bounce_rate=TRUE`, non-transactional sends rejected, transactional pass through.
  - Bounce rate drops to 3% → the pause lifts on next cron run.
- **RAG over-cap:**
  - Submitting a low-relevance chunk when at-cap auto-deletes; `tenant_rag_cap_events` row written with `event_type='submission_auto_deleted'`.
  - Submitting a high-relevance chunk (≥ 0.6) when at-cap: queued for admin review; does NOT count against cap.
- **Promotion bonus persistence:**
  - Promote chunk → `promoted_chunks_count` increments by 1; effective cap raises by 25.
  - Demote (via Prompt 22 demote) → `promoted_chunks_count` does NOT decrement; effective cap STAYS at base + 25.
- **Abuse signals:**
  - Emitting `tenant.rag_pii_recurring_pattern_detected` Inngest event creates an `abuse_signals` row with the right `signal_kind` and `detail`.
  - Same for `chat.anonymous_chat_burst_detected`.
1. **Add to MEMORY.md at end of run:**
- AI pricing catalog source URL and date of last update; whether `AI_PRICING_DEFAULTS` was overridden via `platform_settings.ai_pricing_catalog`.
- Every Claude / OpenAI call site that was migrated to the instrumented wrapper — list the file paths.
- Any call sites that REMAIN un-instrumented — these are bugs to fix.
- The Prompt 26 lint rule `no-direct-anthropic-or-openai-import` is now tightened to allow ONLY `apps/main/src/lib/ai/call-wrapper.ts`.
- The seat_ladder source-of-truth — `platform_settings.seat_ladder` vs hardcoded vs `tier_definitions` — pick one and document.
- **§27.4.2 promotion bonus persistence rule** — call out explicitly as the most surprising rule in §27.
- The `PLATFORM_TENANT_ID` constant used for ambiguous-attribution calls; document its value.
- The Prompt 22 event name reconciliation (`tenant.rag_pii_recurring_pattern_detected` vs actual emitter name).

**Definition of done:**

- `resolveThresholds(tenant, promoted_chunks_count)` produces the right caps for every dimension across the worked examples in §27.4.
- Every Claude/OpenAI call site uses the instrumented wrapper; the lint rule is tight.
- `ai_call_log` rows are written for every call with correct attribution.
- `tenant_usage_metrics` and `tenant_rag_quotas` increment in real time on AI calls, chat messages, emails, invitations, and RAG submissions/deletions.
- The monotonic state-machine fires events on threshold crossings within the billing period.
- The RAG state machine is non-monotonic and reflects current standing.
- AI cost enforcement swaps models at soft1, tightens at soft2, blocks at hard.
- Chat volume enforcement adds delays and fallback at hard.
- Email volume enforcement queues at soft tiers, blocks non-transactional at hard, AND the bounce-rate side channel pauses regardless of monthly state.
- Group invite enforcement adds confirmation, then admin pre-approval, then hard block.
- RAG over-cap auto-deletes low-relevance new submissions; promotion bonus persists after demote.
- Abuse signals from Part 5 events land in the `abuse_signals` table.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 14.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```
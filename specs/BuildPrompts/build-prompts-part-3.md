# Build Prompts — Spec v6.2, Part 3 (Sections 8–13)

## How Part 3 builds on Parts 1 & 2

Part 3 fleshes out the **AI behavior layer** (personas, supervisor, memory), the **RAG service runtime** (shadow tenant table, JWT auth, retrieval API), and the **CRM + host adapter** infrastructure that the rest of the spec leans on. By the end of Part 3, the platform has:

- A RAG service that authenticates main-app callers safely, knows which tenants exist, and exposes the retrieval/ingest/approve API surface.
- All six AI personas defined, with the tenant override table and the two-toggle AI-mode model (per-conversation AI mode + Background AI master switch).
- The supervisor’s regen budget, escalation-topic tracking, sampling review queue, and kill switch.
- The customer-memory extraction Inngest job with the mandatory tenant-scope contract, debounce, optimistic locking, the estimated-DOB lifecycle, and the 24-hour soft-commit transfer for anonymous→authenticated session merges.
- CRM contacts, relationships, pipeline, quotes, commission math, and the host-booking-fee config tables.
- The host-agency adapter registry with the `HostAgencyClient` interface, the credential encryption layer with annual rotation and offsite-key disaster-recovery controls, and the fallback email adapter.

All seven prompts assume Build Prompts 01–07 from Parts 1 & 2 are committed, the migration lint gate is active, and the `tenantClient` / `withPlatformAdminAudit` discipline is in place. Each prompt names the spec sections it depends on.

-----

## Prerequisites added by Part 3

These extend the Part 1 prerequisites list. None of this is code work; line them up before Build Prompt 08.

### 1. New cloud services

|Service        |What you need                                                                                                                                                                |Used in Part 3 sections|
|---------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------|
|**Redis**      |Production Redis instance reachable from the RAG service (Upstash, Redis Cloud, or self-hosted). Used for the JWT `jti` replay cache; required by §8.3 fail-closed contract. |§8.3                   |
|**KMS / vault**|Offsite secondary store for the `APP_ENCRYPTION_KEY_*` set per §13.5.3. Operator preference: 1Password business vault, AWS Secrets Manager in a separate account, or offline.|§13.5                  |

### 2. New keys to generate before Build Prompt 08

- **RS256 keypair** for inter-service JWT signing per §8.3. Private key lives in the main app env vars (`SERVICE_JWT_PRIVATE_KEY`); public key in the RAG service env vars (`SERVICE_JWT_PUBLIC_KEY`). Plan the 90-day rotation cadence per §8.3.
- **`APP_ENCRYPTION_KEY_CURRENT`** — 256-bit base64 key for app-layer credential encryption per §13.5.1. Generate, store in both Vercel env vars AND the offsite vault before Build Prompt 14 runs.
- **`APP_ENCRYPTION_KEY_ID_CURRENT`** — short identifier (e.g., `v1`) stamped onto every ciphertext.

### 3. Decisions to make before Build Prompt 08

- **Redis provider** — Upstash is the easiest fit for serverless (HTTP API, works from Edge if needed) but locks you to one vendor; Redis Cloud or a self-hosted ElastiCache instance keeps things portable. Pick before Prompt 08.
- **Offsite key backup location** — 1Password vs AWS Secrets Manager vs offline. The spec requires *some* offsite store and quarterly verification; the choice is operator preference but must be committed before Prompt 14.

### 4. Open items the spec leaves to implementation

- **Avatar art for the six personas** (per the §9 note “user-provided AI-generated images”). Not blocking code work — placeholders are fine until launch.
- **Initial host adapter** — the spec abstracts host agencies behind `HostAgencyClient` but does not name a launch adapter. Until one is chosen, the fallback email adapter (§13.6) is the only adapter — the platform works end-to-end without an integrated host, just with a manual reference-update step. Decision deferred to Part 4 (§15 onboarding).

-----

## How to use the build prompts below

Same as Parts 1 & 2. Each prompt is self-contained for Claude Code. The header block names the model; the footer switches back to Sonnet. Run in order; review the diff, run tests, commit before moving on. Three of the seven prompts call for Opus — the security-critical, hard-to-fix-later subsections (RAG auth, supervisor regen budget, memory scope contract, credential encryption).

-----

# BUILD PROMPT 08 — RAG service: shadow tenant table, JWT auth, retry queue

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** This prompt builds the security boundary between the main app and the RAG service. The §8.3 fail-closed contract has six failure modes, each with a specific response code; conflating any two (e.g., treating “Redis unreachable” as a “best effort” pass instead of a 503 reject) re-opens replay attacks. The shadow-table model replaces the previous lazy-auto-registration design specifically because the latter was a tenant-injection vector. Get this right the first time.

**Spec references:** Part 3 §8.1 (deployment), §8.2 (tenant registry sync), §8.3 (service-to-service auth + shadow table + fail-closed contract), §8.7 (tenant-events webhook), §8.7a (main-app retry queue for RAG sync).

**Prerequisite check:** Build Prompts 01–07 are committed. The RAG service exists as a separate Next.js app at `apps/rag` with its own Supabase project (per Prompt 06). A Redis instance is provisioned and reachable from the RAG service. An RS256 keypair has been generated and placed in env vars.

**Goal:** Stand up the security backbone for the RAG service: the shadow tenant table on the RAG side, the JWT verification middleware with the full fail-closed contract, the main-app side’s tenant-events webhook publisher, and the `pending_rag_sync` retry queue with its Inngest cron.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   
   ```
   SERVICE_JWT_PRIVATE_KEY (required, secret) — RS256 private key, PEM
   SERVICE_JWT_KEY_ID (required) — short id (e.g., 'v1') for the current signing key
   RAG_SERVICE_URL (required, URL) — e.g., https://rag.ai-travelconcierge.com
   RAG_WEBHOOK_SECRET (required, secret) — shared secret for outbound webhook signature, separate from JWT
   ```
   
   Extend `apps/rag/src/lib/env.ts`:
   
   ```
   SERVICE_JWT_PUBLIC_KEY (required) — RS256 public key, PEM
   SERVICE_JWT_ACCEPTED_KEY_IDS (required) — comma-separated list, e.g., 'v1' or during rotation 'v1,v2'
   REDIS_URL (required, URL) — for jti replay cache
   MAIN_APP_URL (required, URL) — for the nightly reconcile callback to /api/admin/tenants
   MAIN_APP_ADMIN_API_KEY (required, secret) — bearer token the RAG nightly reconcile sends to the main app's tenant-listing endpoint
   RAG_WEBHOOK_SECRET (required, secret) — same secret as main app, verified on inbound /api/tenant-events
   ```
1. **Shadow table migration in the RAG Supabase project.** Migration `apps/rag/supabase/migrations/0007_tenant_registry_shadow.sql`:
- Create `public.tenant_registry_shadow` exactly as §8.3 specifies: `tenant_id UUID PK`, `status TEXT CHECK IN ('active','suspended','terminated','pending_review','onboarding')`, `tenant_type TEXT`, `display_name TEXT`, `last_webhook_sync_at TIMESTAMPTZ DEFAULT NOW()`, `last_reconcile_sync_at TIMESTAMPTZ`, `source_revision INTEGER NOT NULL DEFAULT 0`.
- Add the `tenant_registry_shadow_status_idx` index from §8.3.
- No RLS — RAG side runs service-role exclusively per the Prompt 06 decision. Add a SQL comment making this explicit and document the exception in `apps/rag/db/rls-exceptions.txt` (created in Prompt 06).
- This table is **distinct** from the existing `tenant_registry` table from Prompt 06: the older one was sketched per §6.2 before the shadow design was finalized. **Reconciliation:** check if `tenant_registry` from Prompt 06 has the same shape. If yes, rename it to `tenant_registry_shadow` and migrate its rows. If different shape, drop the old one and create the new one — only if it is empty. Flag this in MEMORY.md.
1. **Source-revision counter in the main app.** Migration `apps/main/supabase/migrations/0008_tenant_source_revision.sql`:
- Add `source_revision INTEGER NOT NULL DEFAULT 0` to `public.tenants`.
- A `BEFORE UPDATE` trigger that increments `source_revision` whenever `status`, `tenant_type`, or `display_name` changes. Do NOT increment on every update — only on changes that the RAG side cares about.
1. **JWT verification middleware on the RAG side.** Create `apps/rag/src/lib/auth/verify-service-jwt.ts`:
- Exports `verifyServiceJwt(req: Request): Promise<ServiceCallerContext>` where `ServiceCallerContext = { tenant_id: string; user_id: string | null; service_identifier: string | null; persona_id: string | null; scope: 'read' | 'write'; jti: string }`.
- Algorithm: RS256. TTL ≤ 5 minutes per §8.3. The check sequence MUST be exactly:
   1. Parse Authorization header → on missing/malformed: throw `ServiceAuthError('missing_token', 401)`.
   1. Verify signature using `SERVICE_JWT_PUBLIC_KEY` and accept-list of key IDs from `SERVICE_JWT_ACCEPTED_KEY_IDS` (to support 90-day rotation overlap) → on fail: `('signature_invalid', 401)`.
   1. Verify `exp` claim ≤ now + 5 min and `iat` claim ≥ now - 5 min → on fail: `('expired', 401)`.
   1. Check `jti` against Redis `SETNX jti:{jti} 1 EX {ttl+30}` → on already-present: `('replay', 401)`. **If Redis is unreachable: throw `('redis_unreachable', 503)`.** Do NOT proceed without the replay check.
   1. Lookup `tenant_id` in `tenant_registry_shadow` → on miss: `('tenant_unknown', 403)`.
   1. Check shadow status === ‘active’ → on any other value: `('tenant_inactive', 403)`.
   1. Any other thrown error during validation → `('internal', 500)`.
- **Hard rule:** every branch above explicitly fails. There is no “best effort” path. Add a comment block at the top of the file quoting §8.3’s fail-closed contract verbatim.
- Add a unit test for EACH of the seven failure modes (six explicit + the success path). Each test asserts the right status code and the right error code in the response body.
1. **Use the middleware in RAG API routes.** Create `apps/rag/src/lib/auth/with-service-auth.ts` exporting `withServiceAuth(handler)` — a higher-order wrapper. All RAG API routes (added in Prompt 09) will call this. Stub routes for now: `/api/retrieve`, `/api/ingest`, `/api/approve/tenant`, `/api/approve/global`, `/api/tenant-events`, all returning 501 *after* successful auth. The 501 stubs prove the auth wrapper works end-to-end.
1. **Tenant-events webhook on the RAG side.** `apps/rag/src/app/api/tenant-events/route.ts`:
- This endpoint is special: it does NOT use `withServiceAuth` (because it’s about telling RAG that tenants exist — chicken-and-egg with shadow table). Instead, verify the request’s `X-Webhook-Signature` header using `RAG_WEBHOOK_SECRET` and HMAC-SHA256 over the raw body.
- Body schema (Zod): `{ event_type: 'tenant.created' | 'tenant.status_changed' | 'tenant.terminated' | 'tenant.metadata_updated', tenant_id: UUID, source_revision: number, payload: { status: string, tenant_type: string, display_name: string } }`.
- Behavior:
  - Read current `tenant_registry_shadow` row by `tenant_id`.
  - If existing row’s `source_revision >= incoming.source_revision`: ack 200 with body `{ ignored: 'stale_revision' }`. Do NOT update.
  - Else: upsert with the new values, set `last_webhook_sync_at = NOW()`, `source_revision = incoming.source_revision`. Return 200.
- Tests: a) valid signature + new revision → upsert. b) valid signature + same revision → ignored. c) invalid signature → 401. d) stale revision → ignored.
1. **Tenant-events webhook publisher on the main-app side.** Create `apps/main/src/lib/rag-sync/publish-tenant-event.ts`:
- Exports `publishTenantEvent({ event_type, tenant_id, source_revision, payload })`. The function:
   1. Computes HMAC-SHA256 over the JSON body with `RAG_WEBHOOK_SECRET`.
   1. POSTs to `${RAG_SERVICE_URL}/api/tenant-events` with header `X-Webhook-Signature: <hex>`.
   1. Retries 3 times with exponential backoff (1s, 5s, 30s) per §8.3.
   1. On final failure: inserts into `pending_rag_sync` (see next task) and returns success to the caller. The originating handler is NOT blocked on RAG sync.
- Wire this into the existing tenant lifecycle paths: tenant create, status change, terminate, metadata update. These paths exist as stubs in Prompt 07 — just add the `publishTenantEvent` call after the DB write commits.
1. **Retry queue on the main-app side.** Migration `apps/main/supabase/migrations/0009_pending_rag_sync.sql`:
- Create `public.pending_rag_sync` per §8.7a (exact columns from the spec: `id`, `tenant_id` FK with `ON DELETE RESTRICT`, `event_type CHECK IN (...)`, `payload JSONB`, `source_revision INTEGER`, `attempt_count INTEGER DEFAULT 0`, `next_retry_at TIMESTAMPTZ DEFAULT NOW()`, `last_attempt_at`, `last_error TEXT`, `created_at`, `delivered_at`).
- Create `pending_rag_sync_ready_idx` per §8.7a (partial index `WHERE delivered_at IS NULL`).
- RLS: This is a platform-internal table. SELECT/INSERT/UPDATE/DELETE allowed only via service-role paths (no authenticated-user policies). Document in `db/rls-exceptions.txt`.
1. **Inngest cron `rag-sync-retry`.** Create `apps/main/src/inngest/rag-sync-retry.ts`:
- Runs every 5 minutes (`cron: '*/5 * * * *'`).
- Selects up to 50 rows where `delivered_at IS NULL AND next_retry_at <= NOW()`. Ordered by `next_retry_at ASC`.
- For each row: re-attempts `publishTenantEvent` with the stored payload. On success: `delivered_at = NOW()`. On failure: increment `attempt_count`, compute backoff per §8.7a table (1m, 5m, 15m, 30m, 1h, 2h, 4h cap), set `next_retry_at`, log `last_error`.
- If `attempt_count >= 10` after the failure: log a platform-admin alert (for now, a `console.error` with structured payload — the alert infra lands later; add `// TODO(platform-alert)`).
- Nightly cleanup job `pending_rag_sync_cleanup` (runs `cron: '0 4 * * *'`): hard-delete rows where `delivered_at IS NOT NULL AND delivered_at < NOW() - INTERVAL '7 days'`.
1. **Nightly reconcile cron on the RAG side.** Create `apps/rag/src/inngest/tenant-registry-reconcile.ts`:
- Runs nightly (`cron: '0 3 * * *'`).
- GETs `${MAIN_APP_URL}/api/admin/tenants?fields=id,status,tenant_type,display_name,source_revision` with `Authorization: Bearer ${MAIN_APP_ADMIN_API_KEY}`. The endpoint on the main-app side is a new route — create it as `apps/main/src/app/api/admin/tenants/route.ts`, authed by the bearer token only (no user JWT), returning all tenants the RAG service needs to know about. Document this endpoint as a platform-internal API in a comment.
- Diffs the response against `tenant_registry_shadow`. For drift:
  - Tenant present in main but absent in shadow → insert.
  - Tenant present in both with different fields → update (use main’s `source_revision`).
  - Tenant present in shadow but absent in main → leave it alone but log a warning (this should never happen; investigate manually).
- Set `last_reconcile_sync_at = NOW()` on every touched row.
- If any drift is detected: log a structured warning per row (for platform-admin alerting later).
1. **Add to MEMORY.md** at end of run: (a) Redis provider chosen; (b) whether the older `tenant_registry` table from Prompt 06 was renamed-in-place or dropped-and-recreated; (c) the 90-day rotation cadence start date for `SERVICE_JWT_PRIVATE_KEY` so the operator can put it on the calendar.

**Definition of done:**

- All seven failure-mode unit tests in `verify-service-jwt.test.ts` pass.
- Integration test: a hand-crafted JWT with a valid signature + active tenant succeeds and reaches the 501 stub. A JWT for a non-shadow tenant returns 403. A JWT replayed within the TTL window returns 401.
- Tenant-events webhook end-to-end: creating a tenant in the main app produces a row in `tenant_registry_shadow` on the RAG side within seconds.
- The retry queue’s backoff schedule produces the right `next_retry_at` values at each attempt count (unit-tested via a clock-injection).
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass for both apps.

**After completion:** MEMORY.md entry covering the items above and noting any deviations.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 09 — RAG service: retrieval, ingest, approval, scope isolation

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 3 §8.4 (POST /api/retrieve), §8.5 (POST /api/ingest), §8.6 (POST /api/approve/tenant and /api/approve/global), §8.8 (PII redaction reference to §6.11 and §22.4), §8.9 (scope isolation). Depends on Part 2 §6.4 (knowledge_chunks), §6.7 (promo lifecycle), §6.10 (feedback factor) — all already in place from Prompt 06.

**Prerequisite check:** Prompt 08 is committed. The JWT auth wrapper works. The 501 stubs from Prompt 08 are the routes we now flesh out (except `/api/tenant-events`, which Prompt 08 finished).

**Goal:** Replace the 501 stubs with the real retrieval, ingest, and approval handlers. Each handler runs *after* `withServiceAuth` succeeds, and uses the validated `tenant_id` from the JWT — NEVER from the request body — as the authoritative scope.

**Tasks:**

1. **Request schemas.** Create `apps/rag/src/lib/schemas/` with Zod schemas mirroring §8.4 request/response shapes exactly:
- `RetrieveRequest`: `query: string`, `tenant_id: UUID`, `user_id: UUID`, `conversation_id: UUID`, `persona_id: UUID`, `filters: { category, cruise_line, ship, destination, agent_slug }` (all optional), `top_k: number ≤ 20`, `include_closed_promos_for_contact: UUID | null`.
- `RetrieveResponse`: `chunks: Chunk[]`, `retrieval_id: UUID`, `retrieval_latency_ms: number`. Each `Chunk` includes `scoring: { match_score, authority, authority_tier, recency, composite_confidence }` and `metadata: { ingested_at, expires_at, is_promo }`.
- **Critical assertion:** the handler MUST verify `body.tenant_id === ctx.tenant_id` from the JWT. If they differ: return 403 with `{ error: 'tenant_id_mismatch_with_jwt' }`. This is defense-in-depth — the JWT is already authoritative, but a mismatched body field is a bug in the caller worth surfacing.
1. **POST /api/retrieve.** Replace stub at `apps/rag/src/app/api/retrieve/route.ts`:
- Wraps handler in `withServiceAuth`.
- Parses request with Zod schema.
- Asserts `body.tenant_id === ctx.tenant_id`.
- Generates query embedding via OpenAI `text-embedding-3-small` (already configured per Prompt 06’s env vars).
- Queries `knowledge_chunks` using the `<=>` cosine-distance operator from pgvector, filtered by `(scope = 'global' OR (scope = 'tenant' AND tenant_id = $1))` per §6.9 / §8.9 — the **only** allowed scope shape. No “tenant inherits from parent” path exists. Tests will verify a tenant cannot retrieve another tenant’s chunks even with a crafted filter.
- Computes the four scoring sub-scores (match_score from cosine distance, authority from the chunk’s `authority_tier`, recency from `ingested_at`, feedback_factor from `compute_feedback_factor` per §6.10) and a composite. Use the weighted formula from §6 (already specified; if not in scope, leave a `// TODO(§6-weighting-formula)` and use equal weights for now).
- Filters out chunks whose `expected_promo_state(now(), sell_by_start_at, sell_by_at, sail_by_at) = 'closed'` per §6.7, UNLESS the chunk’s `contact_id` matches `include_closed_promos_for_contact` (a deliberately-narrow override for the case where a customer is still shopping a deal that closed for new customers).
- Returns top_k results.
- Writes a `rag_retrieval_log` row with the retrieval_id, tenant_id, conversation_id, persona_id, query, top_k, latency.
- On error in any sub-step: returns 500 with `{ error: 'retrieval_internal_error', retrieval_id }`. Logs the full error to the structured logger (not the response body — don’t leak internals).
1. **POST /api/ingest.** Replace stub at `apps/rag/src/app/api/ingest/route.ts`:
- Wraps in `withServiceAuth`. `scope` claim from JWT must be `'write'` — if `'read'`, return 403.
- Body: `{ source_url, source_domain, raw_content, scope: 'tenant' | 'global', tenant_id: UUID, category, ... }`.
- Scope rule: if `body.scope === 'global'`, the JWT’s `service_identifier` claim must be `'platform-admin'` (only platform admins ingest global content). If `body.scope === 'tenant'`, `body.tenant_id` must equal `ctx.tenant_id`.
- PII redaction per §6.11 and §22.4: run the regex pre-filter for zero-tolerance items (passport, credit card). On match: insert into `knowledge_ingestion_queue` with `status = 'quarantined'`, return 422 with `{ status: 'quarantined', queue_item_id, reason: 'zero_tolerance_pii_detected' }`. The Haiku redaction pass for tolerable items (names, emails, phones) is a later prompt — leave a `// TODO(§22.4-haiku-redaction)`.
- On clean content: insert into `knowledge_ingestion_queue` with `status = 'pending_review'` (per §6.5). Return 200 with `{ queue_item_id, status: 'pending_review' }`.
1. **POST /api/approve/tenant and POST /api/approve/global.** Two routes at `apps/rag/src/app/api/approve/tenant/route.ts` and `apps/rag/src/app/api/approve/global/route.ts`:
- Both wrap in `withServiceAuth`. Both require `scope: 'write'`.
- The `/tenant` route requires `body.tenant_id === ctx.tenant_id`. The `/global` route requires `ctx.service_identifier === 'platform-admin'`.
- Body: `{ queue_item_id: UUID, edits?: { content?, category?, source_url?, ... } }`.
- Behavior:
   1. Load the queue item. If status != `'pending_review'`: return 409 `{ error: 'queue_item_not_reviewable' }`.
   1. Apply edits (if any) — Zod-validate the edits subset.
   1. Insert into `knowledge_chunks` with the appropriate scope (`'tenant'` + tenant_id for the /tenant route, `'global'` + tenant_id = NULL for /global). Generate embedding via OpenAI.
   1. Update queue row: `status = 'approved'`, `approved_at = NOW()`, `approved_by_user_id = ctx.user_id`, `resulting_chunk_id = <new chunk id>`.
   1. Return 200 with `{ chunk_id }`.
1. **Scope-isolation integration test** at `apps/rag/test/integration/scope-isolation.test.ts`. This is the most important test in the file — a regression here is the worst-case privacy bug:
- Seed two tenants A and B in `tenant_registry_shadow`. Insert chunks: 3 globals, 2 tenant-scoped to A, 2 tenant-scoped to B.
- JWT signed as tenant A, scope=read, calls `/api/retrieve`. Assert: response includes only the 3 globals + 2 A-chunks. Zero B-chunks, regardless of how the query embedding ranks them.
- JWT signed as tenant A but body’s `tenant_id` set to B → 403.
- JWT signed as tenant A with `scope: 'read'`, attempts `/api/ingest` → 403.
- JWT signed as tenant A attempts `/api/approve/global` → 403.
- JWT signed as platform-admin attempts `/api/approve/global` with a tenant-A queue item → 200 (global approval can promote any tenant’s pending content).
1. **PII redaction module skeleton.** Create `apps/rag/src/lib/pii/regex-prefilter.ts`:
- Exports `detectZeroTolerancePII(text: string): { detected: boolean; categories: ('passport' | 'credit_card' | 'ssn')[] }`.
- Regex patterns: passport (country-specific patterns — at minimum US, UK, Canada, EU forms), credit-card numbers (Luhn-validated), SSN (US format).
- Unit tests covering positives and negatives for each category. Include the “obvious” false positives (e.g., a 16-digit number that isn’t a credit card by Luhn check).

**Definition of done:**

- `/api/retrieve` returns correctly-scored chunks for an end-to-end test query against seeded data, with zero cross-tenant leak.
- `/api/ingest` quarantines content containing a fake passport number and accepts clean content.
- The scope-isolation integration test passes all six cases.
- `rag_retrieval_log` rows appear for every `/api/retrieve` call.
- `pnpm test` in `apps/rag` is green.

**After completion:** MEMORY.md entry noting (a) the placeholder weighting formula in retrieval (TODO until §6’s weighting is unambiguous), (b) the Haiku-redaction TODO in /api/ingest, and (c) any deviations from the spec’s response schemas.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 10 — AI Personas: roster, prompts, tenant overrides, AI Mode + Background AI toggles

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 3 §9 in full. Especially: §9.1 (roster), §9.3 (system prompt three-layer architecture), §9.5 (`tenant_persona_overrides`), §9.6 (tool use list), §9.10 (ai_mode), §9.10.1 (what disabled actually disables — the full table), §9.10.3 (Background AI toggle), §9.10.4 (the §A.13 trap).

**Prerequisite check:** Prompts 01–09 are committed. The CRM `contacts` table does not yet exist (lands in Prompt 13); persona configuration is independent of contacts.

**Goal:** Land the persona schema, the system-prompt builder, the AI Mode + Background AI tenant toggles, the supporting UI surface for the tenant configuration screen, and the tool-use registry stubs. Persona behavior at chat time (the actual runtime — generating responses, the SSE stream) lands in Part 5 §21; this prompt is data + config + UI.

**Tasks:**

1. **Persona base blocks (data, not code).** Create `apps/main/src/lib/personas/base-blocks/` with one TypeScript file per persona: `marcus.ts`, `marco.ts`, `priya.ts`, `dave.ts`, `maya.ts`, `jenny.ts`. Each exports a structured object matching §9.4:
   
   ```typescript
   export const personaBase = {
     slug: 'marcus',
     display_name: 'Marcus Cole',
     specialty: 'Caribbean / Latin America + CATCHALL (default routing)',
     character: { ... },         // §9.4 character block
     expertise_area: { ... },
     anti_instructions: [ ... ], // §9.4 — never claim human, never give medical/legal/financial, never commit on behalf of host
     tone_calibration_placeholder: '{{TONE_CALIBRATION}}',
     disclosure_pattern: '...',  // how to introduce self when asked
   };
   ```
   
   The actual prose content for each persona’s character/voice block is not in the spec — populate with **placeholder text** that’s clearly marked `// TODO(content)` and matches the specialty from the §9.1 table. The full prose is content work, not code work; flag it for the operator to fill in. Marcus is the CATCHALL default per §9.1, so his slug is the default fallback in the router.
1. **Platform constraints block.** Create `apps/main/src/lib/personas/platform-constraints.ts` — a single string constant containing the disclosure rules, prohibited topics (medical/legal/financial advice escalation), and escalation triggers per §9.3. This is appended after every persona’s base block in the final system prompt. Reference §9.7 for the disclosure rules; reference §10’s escalation triggers list.
1. **System prompt builder.** Create `apps/main/src/lib/personas/build-system-prompt.ts`:
- Exports `buildSystemPrompt({ persona_slug, tenant_id, customer_context, tone_level }): Promise<string>`.
- The function:
   1. Loads the base block from `base-blocks/<slug>.ts`. If unknown slug: throw with a clear error.
   1. Appends `platform-constraints.ts`.
   1. If `tenant.tier IN ('sub_agency', 'byo_agency')` per §9.3: loads `tenant_persona_overrides.system_prompt_addendum` (if present) and appends. ONLY for Agency tier — other tiers ignore the addendum even if set.
   1. Substitutes `{{TONE_CALIBRATION}}` with a tone block derived from `tone_level` (1–5 per §24, called out in §11.4). Use placeholder tone language for now; the real §24 tone-matching content is a later prompt — leave `// TODO(§24-tone-content)`.
   1. Appends the `CUSTOMER CONTEXT:` block per §11.4 if `customer_context` is provided.
- Caching: tag the output for Anthropic prompt caching per §9.3 (“The full prompt is cached”). Return both the prompt string and a cache-key derived from `(persona_slug, tenant_id, tone_level, persona_override_version)` so callers can pass it to the Anthropic SDK with the right cache-control headers.
1. **Tenant persona overrides table.** Migration `apps/main/supabase/migrations/0010_tenant_persona_overrides.sql`:
- Create `public.tenant_persona_overrides` exactly per §9.5: `id`, `tenant_id` FK, `persona_slug TEXT NOT NULL`, `display_name_override TEXT`, `system_prompt_addendum TEXT`, `is_disabled BOOLEAN DEFAULT FALSE`, `created_at`, `updated_at`, `UNIQUE (tenant_id, persona_slug)`.
- Index on `tenant_id`.
- RLS: full four-policy set per §5.1.2 minimum (using `auth_user_in_tenant(tenant_id)` + `tenant_is_active(tenant_id)` in WITH CHECK).
- Add to `TENANT_SCOPED_TABLES` in `apps/main/src/lib/db/tenant-scoped-tables.ts`.
- Document a check that’s enforced at the **application layer** (not in SQL): `display_name_override` is null for tier `byo_research`; `system_prompt_addendum` is null for any tier other than `*_agency`. Spec §9.3 makes this a tier-gated feature. Add a unit test on the upsert helper that asserts the tier check.
1. **Persona override Haiku screening.** Create `apps/main/src/lib/personas/screen-addendum.ts`:
- Exports `screenPersonaAddendum(addendum: string): Promise<{ approved: boolean; reasons?: string[] }>`.
- Calls Anthropic Haiku with a screening prompt asking whether the addendum violates platform policy (prompt injection attempts, anti-customer instructions, disclosure-rule violations, etc.).
- This screening is required per §9.3 (“Haiku-screened for safety before save”). The upsert helper (`upsertPersonaOverride`) MUST call this before writing `system_prompt_addendum` — block the write if `approved: false`.
- If `tenant.background_ai_enabled === false` per §9.10.3: the screening cannot run, and `system_prompt_addendum` cannot be saved. Return a 422 to the API caller with a clear message.
1. **AI Mode + Background AI columns.** Migration `apps/main/supabase/migrations/0011_tenant_ai_mode.sql`:
- `ALTER TABLE public.tenants ADD COLUMN ai_mode TEXT NOT NULL DEFAULT 'autonomous' CHECK (ai_mode IN ('autonomous', 'draft_only', 'disabled'));`
- `ALTER TABLE public.tenants ADD COLUMN background_ai_enabled BOOLEAN NOT NULL DEFAULT TRUE;` (per §9.10.3 schema addition, verbatim).
- Both columns default to the spec’s defaults (autonomous + background ON).
1. **AI Mode resolver helper.** Create `apps/main/src/lib/personas/resolve-ai-behavior.ts`:
- Exports `resolveAIBehavior(tenant: Tenant): AIBehaviorFlags` where the flags reflect the §9.10.1 table:
  
  ```typescript
  {
    customer_chat_autonomous_response: boolean,
    customer_chat_draft_for_review: boolean,
    memory_extraction_enabled: boolean,
    persona_addendum_screening_enabled: boolean,
    rag_normalization_ai: 'full' | 'reduced' | 'none',
    pre_cruise_email_personalization: 'ai_generated' | 'template_only',
    forum_moderation: 'haiku_screened' | 'coordinator_only',
    abuse_signal_screening_enabled: boolean,
  }
  ```
- Implements the matrix from §9.10.1:
  - `ai_mode='autonomous'` + `background_ai=ON` → all on.
  - `ai_mode='draft_only'` + `background_ai=ON` → autonomous off, draft on, rest on.
  - `ai_mode='disabled'` + `background_ai=ON` → autonomous AND draft both off; everything else stays on (memory extraction, persona screening, RAG normalization, pre-cruise emails, forum moderation, abuse screening).
  - `background_ai=OFF` (any ai_mode) → forces memory_extraction off, persona_addendum_screening off (so addendums can’t be saved), rag_normalization to ‘none’, pre_cruise to template_only, forum to coordinator_only. Customer chat respects `ai_mode` independently.
- Every chat / extraction / ingestion / moderation path that lands in later prompts MUST call `resolveAIBehavior` and respect the flag. Add unit tests covering each of the eight combinations (2 background × 3 ai_mode).
1. **API routes for tenant AI configuration.** Replace stubs:
- `GET /api/tenant/ai-config` — returns the current `ai_mode`, `background_ai_enabled`, and the resolved behavior flags. Includes per-mode estimated monthly cost ranges per §9.10.2 — for now, “varies based on usage” string is acceptable until §27.12 cost attribution lands.
- `PATCH /api/tenant/ai-config` — accepts `{ ai_mode?, background_ai_enabled? }`. Must `assertPermission` with action `tenant.config.update`. On change, audit-log the before/after.
- `GET /api/tenant/personas` — lists the six base personas + tenant’s overrides merged in.
- `PATCH /api/tenant/personas/[slug]` — accepts `{ display_name_override?, system_prompt_addendum?, is_disabled? }`. Tier-gates as in task 4. Runs Haiku screening on addendum changes (task 5).
1. **Tenant-facing UI for AI Mode configuration.** Create the page at `apps/main/src/app/(tenant)/settings/ai-mode/page.tsx`:
- Three mode cards (autonomous / draft_only / disabled) per §9.10.2.
- Expandable “What does disabled NOT cover?” section reproducing the §9.10.1 table.
- Estimated monthly cost ranges per mode — placeholder until §27.12 lands. Mark `// TODO(§27.12-cost-display)`.
- For `disabled`: a callout linking to the Background AI section below it.
- **Background AI section:** a toggle with default ON. When clicking to turn OFF, surface a confirmation modal reproducing the §9.10.3 banner (“Background AI is OFF. Some platform features have reduced functionality…”). Confirmation required.
- The shadcn `Card`, `Switch`, and `Dialog` primitives — all already configured in Prompt 01.
1. **Tool use registry stubs.** Create `apps/main/src/lib/personas/tools.ts`:
- Exports the six tools from §9.6 as a static array: `search_host_inventory`, `get_customer_context`, `generate_quote`, `collect_booking_details`, `escalate_to_human`, `update_memory`.
- Each tool definition is in Anthropic’s tool-use schema format: `name`, `description`, `input_schema` (JSON Schema). Use placeholder schemas for now — the real schemas are tied to later prompts (host adapter for `search_host_inventory`, CRM for `get_customer_context`, etc.). Mark each placeholder with `// TODO(prompt-XX)`.
- The runtime handler that actually invokes these tools is a later prompt. This task just registers the metadata so the persona system prompt knows what’s available.

**Definition of done:**

- All six persona base-block files exist with the right structural shape (content TODOs are fine).
- `buildSystemPrompt` returns a string with the three layers correctly assembled for each tier.
- The eight `resolveAIBehavior` unit tests pass.
- The `/settings/ai-mode` page renders correctly for each of the three modes; the Background AI toggle requires confirmation to turn off.
- The Haiku screening on addendum upsert correctly blocks adversarial input (test with a fake prompt-injection string).
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry: (a) confirm placeholder persona content is flagged for the operator to fill in pre-launch; (b) the Haiku screening prompt content is in `screen-addendum.ts` — note that it’s first-draft and likely needs operator review before launch; (c) any decisions made about how `display_name_override` propagates to other surfaces (chat header, settings, etc. — Prompt 14 and beyond will use it).

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 11 — AI Supervisor: regen budget, preflight skeleton, escalation topics, review queue, kill switch

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** §10.1a’s regen budget is the AI-cost-bleed defense. Off-by-one errors in the counter, or letting the budget reset on a handoff back to AI, re-introduces the spiral pattern the design is meant to prevent. The kill switch (§10.6) is operator-of-last-resort. Get both right.

**Spec references:** Part 3 §10 in full. Especially: §10.1 (architecture flow), §10.1a (per-conversation regen budget — full text), §10.2 (preflight checks table), §10.3 (topic-level escalation), §10.4 (supervisor_findings JSONB), §10.5a (sampling and review queue — full text including schema), §10.6 (kill switch), §10.7 (metrics).

**Prerequisite check:** Prompts 01–10 are committed. `conversations` and `messages` tables exist (Prompt 05). `tenants` table has `ai_mode` (Prompt 10).

**Goal:** Land the supervisor’s data layer — regen-budget columns, escalation_topics table, supervisor_review_queue, supervisor_findings JSONB convention, kill-switch state, sampling-rate platform_settings entries. Also build the **runtime skeleton**: a `runSupervisor(message, response)` function that runs preflight checks, applies budget, decides pass/regenerate/escalate, and writes findings. The actual check implementations (hallucination_risk, persona_drift, etc.) are stubs that always pass — they get real implementations in Part 5 §21.10 (hallucination defense). This prompt is about the harness.

**Tasks:**

1. **Regen budget columns.** Migration `apps/main/supabase/migrations/0012_conversation_regen_budget.sql`:
- `ALTER TABLE public.conversations` — add `regen_tokens_consumed INTEGER NOT NULL DEFAULT 0`, `regen_count_total INTEGER NOT NULL DEFAULT 0`, `regen_budget_exhausted_at TIMESTAMPTZ` (all per §10.1a verbatim).
1. **Regen budget env vars.** Extend `apps/main/src/lib/env.ts`:
   
   ```
   SUPERVISOR_REGEN_MAX_PER_CONVERSATION (optional, default 6) — absolute regen-attempt cap per conversation
   SUPERVISOR_REGEN_MAX_TOKENS_PER_CONVERSATION (optional, default 25000) — cumulative token cap per conversation
   ```
   
   Defaults from §10.1a verbatim. Document in the env schema that EITHER threshold trips exhaustion.
1. **escalation_topics table.** Migration `apps/main/supabase/migrations/0013_escalation_topics.sql`:
- Create `public.escalation_topics` per §10.3 verbatim: `id`, `tenant_id` FK, `conversation_id` FK, `user_id` FK, `topic_summary TEXT NOT NULL`, `topic_tags TEXT[]`, `status CHECK IN ('open','in_progress','resolved','closed')`, `initiated_by TEXT`, `initiated_reason TEXT`, `assigned_agent_id` FK to users, `opened_at`, `resolved_at`, `resolution_notes TEXT`.
- Indexes: `(tenant_id, status)` for the open-list query, `(conversation_id)` for per-conversation lookup.
- RLS: full four-policy set. Add to `TENANT_SCOPED_TABLES`.
1. **supervisor_review_queue table.** Migration `apps/main/supabase/migrations/0014_supervisor_review_queue.sql`:
- Create `public.supervisor_review_queue` per §10.5a verbatim (every column from the spec’s CREATE TABLE block).
- The `supervisor_review_queue_status_idx` partial index on `(review_status, sampled_at DESC) WHERE review_status = 'pending'`.
- RLS: SELECT/UPDATE allowed only to platform admins (the review queue is platform-internal, not tenant-facing). Document the exception in `db/rls-exceptions.txt`. INSERT/DELETE blocked from authenticated; service-role only.
1. **supervisor sampling rates in platform_settings.** Migration `apps/main/supabase/migrations/0015_supervisor_sampling_settings.sql`:
- Insert four rows into `platform_settings` (created in Prompt 06):
  
  ```
  supervisor_sample_rate_clean_pass: 0.01
  supervisor_sample_rate_warning_pass: 0.10
  supervisor_sample_rate_regen: 0.25
  supervisor_review_retention_days: 90
  ```
- All four per §10.5a’s “Configurable knobs” table verbatim.
1. **`messages.supervisor_findings` JSONB column.** If not already present from Prompt 05, add via migration `0016_messages_supervisor_findings.sql`:
- `ALTER TABLE public.messages ADD COLUMN supervisor_findings JSONB;`
- Define a TypeScript type `SupervisorFindings` per §10.4 in `apps/main/src/lib/supervisor/types.ts`.
1. **Kill switch state.** Migration `apps/main/supabase/migrations/0017_ai_kill_switch.sql`:
- Create `public.ai_kill_switch_state` table: `id INT PRIMARY KEY CHECK (id = 1)` (single-row pattern), `global_paused BOOLEAN NOT NULL DEFAULT FALSE`, `global_paused_at TIMESTAMPTZ`, `global_paused_by_user_id UUID REFERENCES public.users(id)`, `global_paused_reason TEXT`, `updated_at TIMESTAMPTZ DEFAULT NOW()`.
- Seed the single row with id=1, all defaults.
- Per-tenant pause uses the existing `tenants.status` field — `suspended` already exists; no new column needed. Document this decision in a SQL comment.
- RLS: SELECT allowed to any authenticated user (the chat path needs to read this on every turn). INSERT/UPDATE blocked from authenticated; changes only via `withPlatformAdminAudit` paths.
1. **Supervisor runtime skeleton.** Create `apps/main/src/lib/supervisor/run-supervisor.ts`:
- Exports `runSupervisor({ ctx, conversation_id, message_id, candidate_response, retrieved_chunks }): Promise<SupervisorOutcome>` where `SupervisorOutcome = { action: 'allow' | 'regenerate' | 'escalate', findings: SupervisorFinding[], regen_count: number }`.
- Flow per §10.1 + §10.1a:
   1. Load conversation. Check `regen_budget_exhausted_at IS NOT NULL` → if exhausted, skip regen loop entirely; preflight still runs but a flag means flag → direct escalate.
   1. Check kill switch: if `ai_kill_switch_state.global_paused === true`, immediately return `{ action: 'escalate', findings: [{ check: 'kill_switch', severity: 'critical' }], regen_count: 0 }`. The caller will surface the “Our AI is taking a brief break” message per §10.6.
   1. Run the seven preflight checks (stubs for now — each is a file in `apps/main/src/lib/supervisor/checks/`: `hallucination-risk.ts`, `persona-drift.ts`, `promise-detection.ts`, `arithmetic-check.ts`, `compliance-keyword.ts`, `tone-drift.ts`, `topic-escalation.ts`). Each stub takes the candidate response and returns `{ check, severity: 'info' | 'warning' | 'critical', details: string }`. For Prompt 11, every stub returns `{ severity: 'info', details: 'pass (stub)' }`.
   1. Decide action: if any `critical` → escalate; if any `warning` and budget remaining → regenerate; else → allow.
   1. If `regenerate`: check budget. Compute `would_exceed_count = (current.regen_count_total + 1) > MAX_PER_CONVERSATION` and `would_exceed_tokens = (current.regen_tokens_consumed + estimated_tokens) > MAX_TOKENS_PER_CONVERSATION`. If either: set `regen_budget_exhausted_at = NOW()`, return action=‘escalate’ with finding `{ check: 'regen_budget_exhausted' }`. Else: increment columns and return action=‘regenerate’.
   1. Persist the supervisor findings to `messages.supervisor_findings` for the corresponding message_id.
- **Critical:** the regen budget update and the message-findings write happen in a transaction.
1. **promise_detection check stub — but real.** Even though most checks are stubs in Prompt 11, `promise_detection` (§10.2) has a deterministic keyword pattern (`'guaranteed'`, `'I assure you'`, etc.) that’s safe to implement now. Implement the lexical version: matches a hand-curated regex list of promise phrases → returns `severity: 'warning'` with the detected phrase. Soft-rewrite is a runtime concern (Part 5); the stub just flags. Add unit tests.
1. **tone_drift lexical check stub — also real.** Per §10.2, tone_drift has a “deterministic match against slur and hate-speech deny-list per §24.5” sub-check. The deny-list itself is content (operator-managed); store it in `platform_settings` as a JSONB array `supervisor_slur_deny_list` (seeded empty; operator populates pre-launch). The check loads the list and returns `severity: 'critical'` on a match. Implement the loader, the match logic, and a unit test using a stand-in word (“BANNED_WORD_FIXTURE”). Note: §10.2 also says “auto-escalate after 3 consecutive matches” — track consecutive matches in `conversations.supervisor_slur_consecutive_count` (add column in migration 0017). Reset on any clean message.
1. **Sampling logic.** Create `apps/main/src/lib/supervisor/sample-for-review.ts`:
- Exports `maybeSampleForReview({ message_id, conversation_id, tenant_id, outcome, findings, conversation_context })`. Called by the supervisor flow AFTER a final decision is made.
- Reads the four sample-rate settings from `platform_settings`.
- Determines sample category: `clean_pass` (allow + no warnings), `warning_pass` (allow + at least one warning finding), `regen_attempted` (any regen happened in this message’s processing), `escalation` (final action was escalate).
- For categories other than escalation: rolls dice against the rate. Escalation always inserts (rate = 100%).
- On sample hit: inserts into `supervisor_review_queue` with a snapshot of findings and the last N messages of conversation context (N=5 default). `purge_after = NOW() + retention_days days` per the §10.5a default.
1. **Kill switch API.** Two routes:
- `POST /api/admin/ai-kill-switch` — body `{ paused: boolean, reason?: string }`. Requires platform-admin. Wraps in `withPlatformAdminAudit({ reason: 'manual_emergency_intervention', reason_detail: <body reason> })`. Updates the single row. The persona runtime (Part 5) will read this on every chat turn; cache TTL ≤ 30 seconds to balance freshness against per-turn DB hits.
- `POST /api/admin/tenant/:tenant_id/pause-ai` — wraps tenant suspension. Sets `tenants.status = 'suspended'`. Same audit treatment. Per §10.6’s per-tenant pause semantics — the existing tenant-suspended behavior already cuts off customer-facing chat.
1. **Supervisor dashboard (read-only, platform admin).** Create page `apps/main/src/app/(admin)/supervisor/page.tsx`:
- Open topic-level escalations (assigned + unassigned) — query `escalation_topics WHERE status IN ('open', 'in_progress')`.
- Recent flagged messages by check type — last 7 days, grouped by check.
- Per-persona metrics: response count, thumbs-down rate, regen rate. Compute from messages + supervisor_findings.
- Per-tenant aggregates.
- The §10.5a review-queue tab — link to `/admin/supervisor/review-queue` (Prompt 12 lands the review-queue page in detail; Prompt 11 just creates the link).
1. **Tests** under `apps/main/test/integration/supervisor/`:
- Regen budget: a conversation with `regen_count_total = 5`, MAX = 6, sending a warning that requests regen → budget allows one more → after that regen, `regen_count_total = 6`. A subsequent warning → exhaustion → action=escalate, `regen_budget_exhausted_at` set.
- Token budget: same shape but on the token axis.
- Exhausted conversation: a second message in the same conversation after exhaustion → no regen attempt regardless of findings.
- Kill switch: setting `global_paused = true` → next supervisor call returns action=escalate without running checks.
- Sampling: simulate 1000 clean passes at rate 0.01 → expect ~10 queue inserts (assert within ±5 to account for variance).
- Slur match counter: 3 consecutive critical hits → on the third, an escalation_topics row is auto-opened with `initiated_by = 'supervisor'`.

**Definition of done:**

- All 14 tasks complete. Migrations apply cleanly. Lint gate passes.
- The full supervisor flow runs end-to-end against seeded conversations, with the regen budget enforced.
- Kill switch can be toggled by a test platform admin and the next supervisor call respects it.
- All tests pass.

**After completion:** MEMORY.md entry: (a) sampling rates use the spec defaults; tune after first week of production observation; (b) the five “real” preflight checks (hallucination_risk, persona_drift, arithmetic_check, compliance_keyword, tone_drift heuristic) are STUBS — track each as a follow-up item with its §-reference; (c) the slur deny-list in platform_settings is empty at launch — operator must populate before opening to tenants.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 12 — Customer Memory: schema, extraction job with mandatory scope contract, DOB lifecycle, anon→auth transfer

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** This prompt has the highest cross-tenant-leak risk in Part 3. §11.2.2’s mandatory scope contract specifies the exact pattern (Inngest event payload as the sole tenant_id source, tenantClient auto-filter as primary defense, handler-level assertion as defense-in-depth) precisely because the wrong shape — deriving tenant_id from the user’s “current” tenant, for example — produces the worst-case shape of bug. Plus the §11.6 anonymous→authenticated transfer has a 24-hour soft-commit window with deferred derived-data processing; the order of operations on undo is non-trivial. Use Opus.

**Spec references:** Part 3 §11 in full. Especially: §11.1 (customer_memories schema), §11.1.1 (scope discipline), §11.2 (extraction), §11.2.1 (triggers), §11.2.2 (mandatory scope contract — code verbatim), §11.2.3 (debounce), §11.2.4 (optimistic locking), §11.2.5 (process), §11.3 (customer controls), §11.4 (prompt embed), §11.5 (DOB lifecycle — full text), §11.6 (anonymous→authenticated transfer — full flow), §11.7 (audit). Also depends on Part 2 §5.4.5 (tenantContextFromInngestEvent factory) and §26.3a (lint rule for raw service role).

**Prerequisite check:** Prompts 01–11 are committed. The `contacts` table does NOT yet exist (lands in Prompt 13) — `customer_memories.contact_id` will be declared as `UUID` without an FK constraint, with a `// TODO(contacts-fk)` SQL comment. The `anonymous_sessions` table is assumed to exist from earlier auth work; if it doesn’t, this prompt creates a minimal stub.

**Goal:** Land all of Section 11 — the memory schema, the extraction Inngest job, the DOB lifecycle with the nightly re-prompt cron, and the anonymous→authenticated session transfer with its 24-hour soft commit. The retrieved memory in `CUSTOMER CONTEXT:` is consumed by Prompt 10’s `buildSystemPrompt`; this prompt wires the producer side.

**Tasks:**

1. **`customer_memories` table.** Migration `apps/main/supabase/migrations/0018_customer_memories.sql`:
- Create `public.customer_memories` exactly per §11.1: every column verbatim (preferences, travel_history, family_composition, accessibility_needs, dietary_restrictions, loyalty_programs, important_dates, notes_freeform, rapport_tone_level CHECK 1-5, rapport_signals, rapport_level_set_at, last_extracted_at, conversation_count, created_at, updated_at). The `contact_id` column is `UUID` (no FK yet).
- `UNIQUE (tenant_id, user_id)` — the schema-level guarantee per §11.1.1.
- Add `awaiting_dob_reprompt BOOLEAN NOT NULL DEFAULT FALSE` per §11.5’s schema addition.
- RLS: full four-policy set. Add to `TENANT_SCOPED_TABLES`.
1. **`anonymous_sessions` extensions.** Migration `0019_anonymous_sessions_transfer.sql`:
- If `anonymous_sessions` does not exist, create a minimal version: `id UUID PRIMARY KEY`, `tenant_id UUID NOT NULL REFERENCES public.tenants(id)`, `last_active_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ DEFAULT NOW()`. Document this is a stub for later auth work.
- Add the four columns per §11.6: `transfer_soft_commit_at TIMESTAMPTZ`, `transferred_to_user_id UUID REFERENCES public.users(id)`, `transfer_committed_at TIMESTAMPTZ`, `transfer_undo_count INTEGER NOT NULL DEFAULT 0`.
- Add the partial index per §11.6: `anonymous_sessions_pending_commit_idx ON public.anonymous_sessions(transfer_soft_commit_at) WHERE transfer_soft_commit_at IS NOT NULL AND transfer_committed_at IS NULL`.
- RLS: tenant-scoped via `tenant_id` for the read path; full four-policy set. Add to `TENANT_SCOPED_TABLES`.
1. **Memory extraction debounce env vars.** Extend `apps/main/src/lib/env.ts`:
   
   ```
   MEMORY_EXTRACTION_DEBOUNCE_SECONDS (optional, default 120) — minimum gap between extraction runs per (tenant_id, user_id)
   MEMORY_EXTRACTION_MESSAGE_WINDOW (optional, default 50) — number of recent messages fed to Haiku
   MEMORY_EXTRACTION_RETRY_DELAY_MS (optional, default 5000) — delay before re-enqueue on optimistic-lock conflict
   ```
   
   All defaults from §11.2 verbatim.
1. **Inngest event factory.** Extend the existing event types in `apps/main/src/inngest/events.ts` (created in earlier prompts) with:
   
   ```
   'conversation.memory_extract_requested': { tenant_id, conversation_id, user_id }
   'anonymous_session.transfer_finalize': { tenant_id, anonymous_session_id, user_id }
   'dob_reprompt.eligible_check': {} // no payload; cron-driven
   ```
1. **Trigger conditions for extraction.** In the existing chat-completion path (currently stubbed in Prompt 07 at `/api/chat`), add a post-completion hook:
- On every message commit, check the conversation’s message count. If `count % 10 == 0` OR conversation status transitioned to `closed` or `abandoned`: emit `conversation.memory_extract_requested` with `{ tenant_id, conversation_id, user_id }` read from the conversation row at that moment. This is the §11.2.1 trigger. The chat handler stays a stub for now (Part 5 fills it in); this prompt only adds the event emission as a small helper called by whatever lands later.
1. **The memory extraction Inngest function — the high-care piece.** Create `apps/main/src/inngest/extract-memory.ts`:
- Follows §11.2.2’s exact pattern. Copy the code from the spec block verbatim and adapt to the codebase’s actual function-creation API.
- **Mandatory:** `tenant_id` is sourced from `event.data.tenant_id` ONLY. Never from a user lookup, never from a request header, never from any derived field. Add a top-of-file comment block quoting the spec’s emphasis.
- The context is constructed via `tenantContextFromInngestEvent(event)` — that factory was scaffolded in Prompt 03 and uses event payload as the tenant scope. If it doesn’t exist with that exact behavior, fix it in this prompt.
- The handler MUST use `tenantClient(ctx)` for every DB call. The lint rule from §26.3a (and Prompt 03) already forbids raw service-role imports — confirm this file passes lint.
- Defense-in-depth assertion: after fetching the conversation, verify `conversation.user_id === event.data.user_id`. On mismatch: throw with a clear error that names this as the assertion (not a “no such row” error). The error message goes to Inngest’s failure log.
- Debounce per §11.2.3: read `customer_memories.last_extracted_at` for the `(tenant_id, user_id)` pair before issuing the Haiku call. If within `MEMORY_EXTRACTION_DEBOUNCE_SECONDS`, return early with `{ status: 'debounced' }`.
- Haiku call: pull the last N messages (N = `MEMORY_EXTRACTION_MESSAGE_WINDOW`) plus the current `customer_memories` row’s content. Prompt Haiku: “Extract any new facts or updates about this customer; return structured JSON.” Define a Zod schema for the expected return shape (the same fields as `customer_memories`’s JSONB columns) and validate. On Haiku returning unparseable JSON: log + return; do not retry (next natural trigger picks it up).
- Merge: call `mergeMemory(current, extracted)` — implement in `apps/main/src/lib/memory/merge.ts`. The merge is a structural deep-merge favoring extracted over current for non-null values, with arrays union’d by a stable key (e.g., loyalty_programs by program code). Add unit tests covering: new fact, conflicting fact (extracted wins), array union, no-op when extracted is empty.
- Optimistic-locking update per §11.2.4: conditional UPDATE on `updated_at = current.updated_at`. On `result.data.length === 0` (someone else committed between read and write): re-enqueue the same event with `ts = Date.now() + MEMORY_EXTRACTION_RETRY_DELAY_MS`.
- On success: set `last_extracted_at = NOW()`, increment `conversation_count` if a new conversation closed.
1. **Memory extraction respects `memory_opt_out` and `background_ai_enabled`.** Before doing any work:
- Check `users.memory_opt_out` for the user → if true, return early.
- Check `tenants.background_ai_enabled` via `resolveAIBehavior` (Prompt 10) → if `memory_extraction_enabled === false`, return early with `{ status: 'background_ai_disabled' }`.
- These two checks happen BEFORE the debounce read so opted-out users don’t even touch the read path.
1. **DOB lifecycle — schema and helpers.** In `apps/main/src/lib/memory/dob.ts`:
- Type definition for the `family_composition` entry per §11.5’s storage shape: includes `date_of_birth`, `date_of_birth_is_estimated`, `estimation_basis`, `estimation_recorded_at`, `estimation_last_reprompt_at`.
- Helper `isEstimatedDOBOverdue(entry): boolean` — true when `date_of_birth_is_estimated === true AND estimation_recorded_at < NOW() - 365 days AND (estimation_last_reprompt_at IS NULL OR estimation_last_reprompt_at < NOW() - 365 days)` per §11.5.
- Helper `suppressDOBContentForEstimated(entry): boolean` — true if estimated (used by §23 pre-cruise email rendering, §12 quote PDFs, etc.; just expose the helper here).
1. **DOB re-prompt nightly cron.** Create `apps/main/src/inngest/dob-estimate-reprompt-eligible.ts`:
- Runs nightly (`cron: '0 5 * * *'`).
- Selects `customer_memories` rows where:
  - Any family member entry in the JSONB has `date_of_birth_is_estimated = true`.
  - The associated user has had a message in the last 90 days (per §11.5 “still in active conversation”).
  - The estimated entry is overdue per `isEstimatedDOBOverdue`.
- JSONB filter is non-trivial — use a JSONB path query with `jsonb_path_exists`. Add a unit test for the SQL.
- For each match: update the memory row’s `awaiting_dob_reprompt = true`. Do NOT update `estimation_last_reprompt_at` here — that happens when the persona actually issues the re-prompt at chat time.
- Persona prompt augmentation logic (in `buildSystemPrompt` from Prompt 10): if `customer_memories.awaiting_dob_reprompt === true`, append a system-prompt instruction: “In your next response, gently re-confirm Mike’s birthday — phrasing per §11.5.” Then clear the flag and set `estimation_last_reprompt_at = NOW()` for the affected entry. This update happens after the persona response commits.
1. **Customer memory controls API.** Replace stubs:
- `GET /api/memory` — returns the current user’s `customer_memories` row for the active tenant.
- `PATCH /api/memory` — accepts a partial update payload. Validates against Zod schema. Updates only the fields in the request. Audit-logs to `audit_log` (Prompt 11 stubs this to console.warn until Section 26 ships).
- `DELETE /api/memory` — clears the user’s memory for the active tenant (sets JSONB columns to NULL, keeps the row for FK integrity).
- `POST /api/memory/opt-out` — sets `users.memory_opt_out = true`. Future extraction jobs no-op.
1. **Anonymous→authenticated transfer flow.** §11.6 is the most procedurally complex part of this prompt. Create:
- `apps/main/src/lib/transfer/anon-to-auth.ts` exporting `softCommitTransfer({ anonymous_session_id, user_id, tenant_id })`. On call:
   1. Update the `anonymous_sessions` row: `transfer_soft_commit_at = NOW()`, `transferred_to_user_id = user_id`.
   1. Re-key the conversation: all messages and the conversation row’s `user_id` updates to the authenticated user_id. The session_id link is retained for the undo window.
   1. Emit Inngest event `anonymous_session.transfer_finalize` with a delay of 24 hours.
   1. Audit-log `action: 'session_transfer.soft_committed'`.
   1. Return `{ status: 'soft_committed', expires_at: NOW() + 24 hours }`.
- `undoTransfer({ anonymous_session_id, user_id })`. Authorization: the user_id MUST match `transferred_to_user_id`. On call:
   1. Assert `transfer_committed_at IS NULL` (i.e., still in soft window). If already committed: return 409 `{ error: 'transfer_already_finalized' }`.
   1. Set `transfer_soft_commit_at = NULL`, `transferred_to_user_id = NULL`, increment `transfer_undo_count`.
   1. Reverse the conversation re-keying: messages and conversation revert to the anonymous session.
   1. Cancel the pending Inngest finalize event (use Inngest’s `cancelOn` machinery or a no-op flag on the event).
   1. Audit-log `action: 'session_transfer.undone'` with a snapshot of message count and time range per §11.6.
   1. Return `{ status: 'undone' }`.
- The transfer-finalize Inngest function: triggers on `anonymous_session.transfer_finalize`. Re-reads the session: if `transfer_committed_at IS NOT NULL` already → noop. If `transfer_soft_commit_at IS NULL` → noop (undone). Else: set `transfer_committed_at = NOW()`, then run the deferred processing — emit `conversation.memory_extract_requested` for each transferred conversation, create CRM contact (deferred to Prompt 13 if `contacts` doesn’t exist yet — leave a `// TODO(prompt-13)`), schedule pre-cruise emails if applicable (later prompt).
1. **Deferred-processing guarantee.** Add an assertion module `apps/main/src/lib/transfer/deferred-processing-guard.ts`:
- Exports `assertNotInDeferredWindow(conversation_id): Promise<void>`. Reads the related anonymous_session: if `transfer_soft_commit_at IS NOT NULL AND transfer_committed_at IS NULL`, throws `DeferredProcessingError`.
- This guard is called at the top of: memory extraction, CRM contact creation (Prompt 13), pre-cruise email scheduling (later). If thrown, those handlers return early without doing work.
- Per §11.6: this is what makes undo simple — no derived data exists yet because all derived-data-producers gate on this guard during the 24h window.
1. **Transfer consent UI.** Sign-up flow (already stubbed in Prompt 07’s auth routes) gains a consent screen after OAuth completion when an anonymous session is detected:
- Page `apps/main/src/app/auth/transfer-consent/page.tsx`.
- Shows the §11.6 preview: total message count, time span, first ~20 words of each message (truncated, not full content).
- Two buttons: “Yes, keep it” → calls `softCommitTransfer`; “No, start fresh” → marks anonymous session discarded.
- Notice text per §11.6 verbatim.
1. **Persistent undo banner.** Create `apps/main/src/components/transfer/UndoBanner.tsx`:
- Renders at the top of `/settings/conversations` when the current user has an anonymous_session row with `transfer_soft_commit_at IS NOT NULL AND transfer_committed_at IS NULL`.
- Banner text per §11.6 verbatim, with a countdown showing hours remaining.
- “Undo this transfer” button calls `undoTransfer`.
- After 24h: banner replaced with “Transfer made permanent on [DateTime]” (one display refresh; not persistent).
1. **Tests** under `apps/main/test/integration/memory/` and `apps/main/test/integration/transfer/`:
- **Cross-tenant scope test (the most important one):** Seed two tenants A and B with two users sharing the same auth user_id mistakenly. Emit `conversation.memory_extract_requested` with `tenant_id = A`. After the job runs: assert tenant A’s memory row was updated; tenant B’s memory row was NOT touched, even if the user has rows in both tenants. Add a second test where the conversation_id passed in the event belongs to tenant B but the event’s `tenant_id` is A → the auto-filter from `tenantClient` returns zero rows on the conversation fetch → the defense-in-depth assertion fires → the job throws cleanly. No data is modified.
- Debounce: emit two events back-to-back within `MEMORY_EXTRACTION_DEBOUNCE_SECONDS` → second one returns `{ status: 'debounced' }` without a Haiku call.
- Optimistic lock: simulate two concurrent extractions racing → one wins, the other re-enqueues with the configured delay.
- DOB re-prompt: seed a memory with an estimated DOB 400 days old → run the cron → `awaiting_dob_reprompt = true`. Run again with the flag already true → idempotent.
- Transfer happy path: anonymous → soft commit → 24 hours simulated → finalize → memory extraction runs.
- Transfer undo: anonymous → soft commit → undo within 24h → conversation reverts; assert NO memory extraction has run (the guard worked).
- Transfer undo after finalize: anonymous → soft commit → 25 hours simulated → undo attempt → 409.

**Definition of done:**

- The cross-tenant scope test is the gate. It must pass.
- All migrations apply, RLS lint gate green.
- Customer memory CRUD works end-to-end via the API routes.
- DOB cron correctly identifies overdue estimates.
- Transfer flow works in both directions (commit and undo) within the 24h window.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all green.

**After completion:** MEMORY.md entry: (a) confirm the Inngest-event-as-authoritative-scope pattern works; (b) the merge logic in `merge.ts` made a specific choice on each conflict type — document them; (c) the DOB re-prompt persona instruction is appended to the system prompt at chat time — note where in the chat handler this lives; (d) the transfer undo cancellation of the finalize event uses [Inngest cancelOn / a flag] — document the approach; (e) flag the `contacts` FK on `customer_memories.contact_id` and the CRM contact creation in `transfer-finalize` as pending Prompt 13.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 13 — CRM: contacts, relationships, pipeline, quotes, host-booking-fee configs

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 3 §12 in full. §12.1 (contacts), §12.2 (contact_relationships), §12.3 (pipeline), §12.4 (quotes), §12.5 (commissionable fare table), §12.6 (host booking fee configs + tenant overrides), §12.7 (commission math worked example).

**Prerequisite check:** Prompts 01–12 are committed. `customer_memories.contact_id` has a TODO awaiting this prompt’s `contacts` table.

**Goal:** Land the CRM schema, the relationship graph, the quote builder + its PDF rendering surface, and the host-booking-fee config tables. Also resolve the deferred FK from §11 (`customer_memories.contact_id`). The runtime commission math (using these tables) lands in Part 4 §14; this prompt is the schema + the read/write API surface + the CRM UI shells.

**Tasks:**

1. **`contacts` table.** Migration `apps/main/supabase/migrations/0020_contacts.sql`:
- Create `public.contacts` exactly per §12.1: every column verbatim (`first_name`, `last_name`, `middle_name`, `preferred_name`, `email`, `phone`, `date_of_birth`, `date_of_birth_is_estimated`, `estimation_basis`, `gender`, `nationality`, `passport_expiry`, `loyalty_programs JSONB`, `dietary_restrictions`, `accessibility_needs`, `source`, `source_reference`, `created_by_user_id`, `created_at`, `updated_at`). `user_id` is nullable per the spec (“not all contacts are platform users”).
- The three indexes from §12.1: `contacts_tenant_idx`, `contacts_email_idx (tenant_id, email)`, `contacts_name_idx (tenant_id, last_name, first_name)`.
- RLS: full four-policy set. Add to `TENANT_SCOPED_TABLES`.
1. **Resolve the deferred FK.** Migration `0021_resolve_customer_memories_contact_fk.sql`:
- `ALTER TABLE public.customer_memories ADD CONSTRAINT customer_memories_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;`
- Resolve the `// TODO(contacts-fk)` comment from Prompt 12 in the migration source comments.
1. **Resolve the deferred FK on `conversations.contact_id` as well.** It was flagged in Prompt 05’s task 1. Same migration `0021`:
- `ALTER TABLE public.conversations ADD CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;`
1. **`contact_relationships` table.** Migration `0022_contact_relationships.sql`:
- Create per §12.2 exactly: `from_contact_id` + `to_contact_id` FKs both `ON DELETE CASCADE` so removing a contact removes its edges. `relationship_type` is a free-text column (per spec — not enumed) but document the canonical values in a SQL comment: ‘spouse’, ‘partner’, ‘parent_of’, ‘child_of’, ‘sibling’, ‘friend’, ‘colleague’.
- `confidence NUMERIC(3,2)` for AI-inferred relationships.
- The `UNIQUE (tenant_id, from_contact_id, to_contact_id, relationship_type)` constraint prevents duplicate edges.
- RLS: full four-policy set. The two contact FKs guarantee both endpoints are in the same tenant (otherwise the FK fails per RLS), but the `tenant_id` column on this table is the authoritative scope.
1. **Pipeline configuration.** §12.3 defines a default pipeline that’s tenant-configurable. Migration `0023_pipeline_stages.sql`:
- Create `public.pipeline_stages`: `id`, `tenant_id` FK, `stage_key TEXT NOT NULL` (e.g., ‘lead’, ‘qualified’, ‘quote_sent’, ‘quote_accepted’, ‘booked’, ‘sailed’, ‘lost’, ‘post_trip_followup’), `display_name TEXT NOT NULL`, `ordinal INTEGER NOT NULL`, `is_terminal BOOLEAN NOT NULL DEFAULT FALSE`, `is_lost_status BOOLEAN NOT NULL DEFAULT FALSE`, `created_at`, `updated_at`, `UNIQUE (tenant_id, stage_key)`.
- Add a `contacts.pipeline_stage_key TEXT` column (nullable; a contact may not be in the pipeline at all). FK is a soft reference — pipeline_stages is tenant-scoped so a hard FK would require `(tenant_id, stage_key)` composite key, which complicates things. Document this as a deliberate soft-reference in a SQL comment; the application layer validates the stage exists for the contact’s tenant.
- On tenant creation (the existing tenant-create flow from earlier prompts): seed the eight default stages with the spec’s default values + ordinals.
- RLS: full four-policy set on `pipeline_stages`. Add to `TENANT_SCOPED_TABLES`.
1. **`quotes` table.** Migration `0024_quotes.sql`:
- Create `public.quotes` exactly per §12.4: every column verbatim. `converted_to_booking_id` is `UUID REFERENCES public.bookings(id)` — `bookings` exists from Prompt 05. Set `ON DELETE SET NULL` so a deleted booking doesn’t cascade-delete the quote.
- Index on `(tenant_id, status)` for the pipeline view.
- RLS: full four-policy set. Add to `TENANT_SCOPED_TABLES`.
1. **Commissionable fare reference data.** §12.5’s table is a reference table, not a per-tenant config. Create `apps/main/src/lib/commissions/commissionable-line-items.ts`:
- Exports a constant array mapping each line item category from §12.5 to its commissionable status: `'always_commissionable'`, `'never_commissionable'`, `'reduces_commissionable_fare'`, `'line_specific_varies'`.
- This is consumed by Part 4’s commission math, but the reference table belongs here so quotes can render the right labels.
1. **Host booking fee config tables.** Migration `0025_host_booking_fee_configs.sql`:
- Create `public.host_booking_fee_configs` per §12.6 exactly: `host_adapter`, `fee_type CHECK IN ('none','flat','percent','tiered')`, `flat_fee_amount`, `percent_of_commission`, `tiered_rules JSONB`, `minimum_commission_threshold`, `effective_from DATE NOT NULL`, `effective_to DATE`, `created_at`. This is **platform-scoped** (not tenant-scoped) — it defines fees per host adapter as configured by the operator. No `tenant_id` column.
- Create `public.tenant_host_fee_overrides` per §12.6 exactly. This IS tenant-scoped — tenants can override the default fee config for their specific arrangement with the host.
- RLS: `host_booking_fee_configs` — SELECT to authenticated, INSERT/UPDATE/DELETE platform-admin only (operator data). `tenant_host_fee_overrides` — full four-policy set.
- Add `tenant_host_fee_overrides` to `TENANT_SCOPED_TABLES`.
1. **Commission math worked-example test.** Even though the runtime math lands in Part 4, codify §12.7’s worked example as a regression test that the math library (when it lands) must satisfy. Create `apps/main/test/fixtures/commission-worked-examples.ts`:
   
   ```typescript
   export const workedExamples = [
     {
       label: '§12.7 — $5000 fare, 15% commission, $25 flat host fee, sub-host Pro 20/80',
       inputs: {
         commissionable_fare_cents: 500000,
         host_commission_rate_basis_points: 1500,
         host_booking_fee_type: 'flat',
         host_booking_fee_amount_cents: 2500,
         tenant_type: 'sub_host',
         tenant_tier: 'sub_pro',
         platform_share_basis_points: 2000,
       },
       expected: {
         gross_commission_cents: 75000,
         host_fee_deduction_cents: 2500,
         net_to_platform_cents: 72500,
         platform_take_cents: 14500,
         tenant_retains_cents: 58000,
       },
     },
     // Add: percent-fee variant, tiered-fee variant, no-fee variant, byo-host (different share model) variant
   ];
   ```
   
   This file is consumed by Part 4’s commission math implementation. For now, no calling code exists — just the fixtures. The test runner uses `it.skip(...)` for now; Part 4 enables the tests.
1. **CRM API routes (de-stub).** Replace stubs from Prompt 07:
- `GET /api/crm/contacts` — list contacts in the current tenant. Query params: `pipeline_stage_key`, `search`, `limit`, `offset`. Returns paginated.
- `POST /api/crm/contacts` — create a contact. Body: Zod-validated contact fields. Sets `created_by_user_id = ctx.user_id`.
- `PATCH /api/crm/contacts/[id]` — update fields. Audit-log diff.
- `GET /api/crm/contacts/[id]/timeline` — returns a merged timeline of: conversations involving this contact (via `conversations.contact_id`), quotes for this contact, bookings for this contact, audit log events related to this contact. Order by timestamp DESC.
- `POST /api/crm/contacts/[id]/relationships` — add a relationship edge.
- `DELETE /api/crm/contacts/[id]/relationships/[rel_id]` — remove an edge.
- `POST /api/quotes` — create a draft quote. Body: trip details + line items.
- `POST /api/quotes/[id]/send` — set status=‘sent’, generate the customer-facing PDF (use a PDF lib like `@react-pdf/renderer` — confirm the choice; or defer the actual PDF rendering to a stub returning a presigned URL placeholder for now).
- `POST /api/quotes/[id]/accept` — customer accepts (or agent marks accepted). Sets status=‘accepted’, accepted_at.
1. **CRM UI shells.** Create the basic shells at:
- `apps/main/src/app/(tenant)/crm/contacts/page.tsx` — list with search + pipeline filter.
- `apps/main/src/app/(tenant)/crm/contacts/[id]/page.tsx` — detail with timeline + relationship graph.
- `apps/main/src/app/(tenant)/crm/quotes/page.tsx` — quote list.
- `apps/main/src/app/(tenant)/crm/quotes/[id]/page.tsx` — quote detail with line-item editor.
- These are functional but minimal — populate from the API routes above. Polish is later.
1. **DOB display rules from §11.5.** Apply the visual marker rules per §11.5’s table:
- In the contact detail view: if `date_of_birth_is_estimated`, show “(estimated, click to confirm)” next to the DOB field. Clicking opens an edit modal where the agent can confirm or update.
- In quote PDFs: estimated DOBs are NOT rendered at all (the §11.5 table says “not rendered”). The PDF generator skips any DOB-derived content when `date_of_birth_is_estimated === true`.
- Add this as a helper `apps/main/src/lib/contacts/dob-display.ts` consumed by both the contact view and the quote PDF generator.
1. **Tests** under `apps/main/test/integration/crm/`:
- Cross-tenant isolation: a contact in tenant A is not visible to a user in tenant B.
- Relationships: adding a cycle (A→B→A) is allowed (different relationship types); duplicate edge (A→B as ‘spouse’ twice) is blocked by the UNIQUE constraint.
- Quote lifecycle: draft → sent → accepted → converted (with `converted_to_booking_id` set).
- Pipeline: contacts move between stages; the timeline view includes pipeline transition events (if audit-logged — confirm the existing audit pattern from Prompt 03 covers PATCH on contacts).
- DOB display: a contact with an estimated DOB renders the “(estimated)” marker; a confirmed DOB does not.

**Definition of done:**

- All migrations apply; lint gate passes.
- CRM API routes work end-to-end against seeded contacts.
- The deferred FK on `customer_memories.contact_id` and `conversations.contact_id` is resolved.
- Worked-example fixtures exist (tests skipped, awaiting Part 4 implementation).
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all green.

**After completion:** MEMORY.md entry: (a) the PDF rendering library chosen (or deferred); (b) confirmation that `customer_memories.contact_id` and `conversations.contact_id` FKs are now hard-enforced; (c) the pipeline-stages soft-reference decision (no composite FK from contacts to pipeline_stages); (d) the commission math worked-example fixtures are in place but tests are skipped until Prompt 14/Part 4.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 14 — Host Agency Abstraction: HostAgencyClient, adapter registry, encrypted credentials with DR, fallback email adapter

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** §13.5’s credential encryption layer is the platform’s “lose-the-keys, lose-the-business” surface. Failure mode 1 (both keys lost) is unrecoverable. Failure mode 3 (rotation gone wrong) is hardest to diagnose. The four DR controls — offsite backup, quarterly verification, gated env-var deletion, boot-time validation — are mandatory and must be present from day one. Use Opus.

**Spec references:** Part 3 §13 in full. §13.1 (goals), §13.2 (`HostAgencyClient` interface), §13.3 (adapter registry), §13.4 (tenant host configs), §13.5 (credential storage — full text including 13.5.1 key storage/rotation, 13.5.2 failure modes, 13.5.3 DR controls, 13.5.4 partial-degraded mode, 13.5.5 calls worth flagging), §13.6 (fallback email adapter), §13.7 (adapter selection flow). Cross-references: §28.13 (env var definitions), §28.20 (rotation policy), §A.X (MEMORY logging of backup verification).

**Prerequisite check:** Prompts 01–13 are committed. `APP_ENCRYPTION_KEY_CURRENT` and `APP_ENCRYPTION_KEY_ID_CURRENT` are in env vars AND in the offsite backup (per Part 3 prerequisites). The operator has confirmed the offsite location and committed to quarterly verification.

**Goal:** Land the host-agency abstraction layer: the TypeScript interface, the adapter registry, the tenant host config table with encrypted credentials, the encryption library with rotation support, the four DR controls, the fallback email adapter, and the adapter-selection runtime helper. The actual booking submission via these adapters lands in Part 4 §14; this prompt is the substrate.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   
   ```
   APP_ENCRYPTION_KEY_CURRENT (required, secret) — base64 256-bit key
   APP_ENCRYPTION_KEY_ID_CURRENT (required) — short identifier (e.g., 'v1')
   APP_ENCRYPTION_KEY_PREVIOUS (optional, secret) — set only during 90-day rotation overlap
   APP_ENCRYPTION_KEY_ID_PREVIOUS (optional) — short identifier for the previous key
   HOST_ADAPTER_FALLBACK_EMAIL_TO (required, when fallback adapter is used) — email address that receives the structured booking details
   HOST_ADAPTER_FALLBACK_EMAIL_FROM (required, when fallback adapter is used) — sender address
   ```
   
   **Boot-time validation per §13.5.3:** extend `verifyEnvAtBoot()` from Prompt 01:
- Assert `APP_ENCRYPTION_KEY_CURRENT` decodes to exactly 32 bytes.
- Assert `APP_ENCRYPTION_KEY_ID_CURRENT` is non-empty.
- If `APP_ENCRYPTION_KEY_PREVIOUS` is present, assert it decodes to exactly 32 bytes AND `APP_ENCRYPTION_KEY_ID_PREVIOUS` is non-empty.
- On any failure: service refuses to start. The boot check log line includes which validation failed (without leaking the key material).
1. **Encryption library.** Create `apps/main/src/lib/crypto/credential-cipher.ts`:
- Exports `encryptCredential(plaintext: string): { ciphertext: string; key_id: string }`. Uses AES-256-GCM with a fresh 12-byte IV per call. Output ciphertext format: base64-encoded `iv || tag || ciphertext` (concatenated). Returns the IV-tag-ciphertext bundle plus the `APP_ENCRYPTION_KEY_ID_CURRENT` it used.
- Exports `decryptCredential({ ciphertext: string; key_id: string }): Result<string, DecryptionError>` — returns a structured Result type, NOT a thrown exception, per §13.5.3 (“returns a structured error (NOT a thrown exception that crashes the request)”).
  - If `key_id === APP_ENCRYPTION_KEY_ID_CURRENT`: decrypt with current key.
  - Else if `key_id === APP_ENCRYPTION_KEY_ID_PREVIOUS`: decrypt with previous key.
  - Else: return `Err({ code: 'unknown_key_id', key_id })`.
  - On GCM auth tag mismatch: return `Err({ code: 'auth_tag_mismatch', key_id })`.
  - On any other crypto error: return `Err({ code: 'decryption_failed', key_id })`.
- **Audit-log on every decryption failure** per §13.5.3: emit `audit_log` row with `action: 'credential.decryption_failed'`, including a SHA-256 hash of the ciphertext (NOT the ciphertext itself), the failure code, and the key_id. The hash enables forensic correlation without exposing the (encrypted) material.
1. **`host_adapters` registry table.** Migration `apps/main/supabase/migrations/0026_host_adapters.sql`:
- Create `public.host_adapters` per §13.3 exactly: `adapter_id TEXT UNIQUE NOT NULL`, `display_name`, `implementation_path TEXT NOT NULL` (path to the TS module), `config JSONB NOT NULL`, `capabilities JSONB NOT NULL`, `is_active BOOLEAN DEFAULT TRUE`, `is_default BOOLEAN DEFAULT FALSE`, `health_check_status CHECK IN (...)`, `health_check_last_at`, `health_check_message`, `created_at`.
- The `host_adapters_default_idx` partial unique index per §13.3 ensures only one adapter can be `is_default = true`.
- RLS: SELECT to authenticated (tenants can see the catalog of adapters); INSERT/UPDATE/DELETE platform-admin only. Document in `db/rls-exceptions.txt`.
1. **`tenant_host_configs` table.** Migration `0027_tenant_host_configs.sql`:
- Create `public.tenant_host_configs` per §13.4 exactly. The `credentials JSONB NOT NULL` column stores the encrypted credential bundle: `{ "ciphertext": "...", "key_id": "v1" }`.
- SQL comment on the `credentials` column: “Application-layer encrypted via AES-256-GCM per §13.5. Never read raw — always go through `apps/main/src/lib/crypto/credential-cipher.ts`.”
- `credential_status CHECK IN ('pending','verified','rejected','expired','revoked')`.
- `UNIQUE (tenant_id, adapter_id)`.
- RLS: full four-policy set. Add to `TENANT_SCOPED_TABLES`.
1. **`HostAgencyClient` interface.** Create `packages/shared-types/src/host-agency.ts`:
- Define `HostAgencyClient`, `HostCapabilities`, `InventorySearchRequest`, `BookingSubmissionRequest`, `CancellationRequest`, `ModificationRequest`, `StatementFetchRequest`, `CommissionPaymentRequest`, `HostCallContext` exactly per §13.2 (the spec only gives the interface signature; flesh out the request/response types with sensible structures derived from the rest of the spec — e.g., `InventorySearchRequest` includes `destination`, `dates`, `passenger_count`, `cruise_lines` per general industry shape).
- All method return types: `Promise<Result<T, HostAdapterError>>`. `HostAdapterError` is a discriminated union: `{ code: 'auth_failed' | 'rate_limited' | 'not_found' | 'validation' | 'host_unavailable' | 'unsupported' | 'internal'; message: string }`. Adapters never throw; they always return Result. The caller decides how to handle each error code.
1. **Adapter loader.** Create `apps/main/src/lib/host-adapters/registry.ts`:
- Exports `getAdapter(adapter_id: string): Promise<HostAgencyClient>`. Reads the `host_adapters` row, dynamically imports `implementation_path`, instantiates and returns.
- Caches adapter instances in-process (they’re stateless after construction, but constructing repeatedly wastes effort).
- `listActiveAdapters()` for the tenant settings page.
1. **Fallback email adapter.** Create `apps/main/src/lib/host-adapters/fallback-email/adapter.ts` implementing `HostAgencyClient`:
- `adapterId = 'fallback-email'`, `displayName = 'Manual / Email Fallback'`.
- `capabilities`: `supports_inventory_search: false`, `supports_real_time_booking: true` (it “books” by emailing), `supports_modification: false`, `supports_cancellation: false`, `supports_commission_api: false`, `booking_types: []`, `cruise_lines_supported: []`, `commission_currency: 'USD'`, `payment_lag_days_typical: 0`.
- `submitBooking(req, ctx)`: renders an email with the structured booking details (use the React Email infra from Part 2’s setup), sends via Resend to `HOST_ADAPTER_FALLBACK_EMAIL_TO`. Returns synthetic `provider_booking_ref: 'EMAIL-{tenant_id}-{timestamp}'` per §13.6.
- All other methods return `Err({ code: 'unsupported', message: 'Fallback email adapter does not support this operation' })`.
- `healthCheck()`: returns ok if Resend is reachable.
- Seed `host_adapters` with a row for the fallback adapter: `adapter_id='fallback-email'`, `is_active=true`, `is_default=true` (per §13.7’s “Tenant is platform → use platform default” branch — until a real adapter is added, the fallback IS the default).
1. **Adapter selection helper.** Create `apps/main/src/lib/host-adapters/select-adapter.ts`:
- Exports `selectAdapter({ tenant }): Promise<HostAgencyClient>` implementing §13.7’s flow:
   1. Check `tenant_host_configs` for this tenant. If `credential_status === 'verified'` row exists: use that adapter.
   1. Else if tenant is sub-host: use platform default + sub-host credentials.
   1. Else if tenant is platform (Prong 1): use platform default.
   1. Else: use fallback email adapter.
- Wraps the credential lookup in the decryption path. If decryption fails per §13.5.4: return a special `HostAgencyClient` shape that always returns `Err({ code: 'auth_failed', message: 'Credentials need to be re-entered — please visit Settings > Host Integration' })` for any operation. **Do NOT silently fall back to the email adapter** per §13.5.3 — that would mask a security incident.
1. **Tenant-facing partial-degraded mode banner.** Per §13.5.4:
- When `tenant_host_configs.credential_status === 'rejected'` OR a recent decryption failure was logged for this tenant’s credential: a banner renders at the top of the tenant dashboard.
- Banner copy per §13.5.4: “Your [adapter display name] credentials cannot be loaded. Please re-enter them in Settings to resume bookings.”
- The banner state is computed by reading a `tenant_credential_health` view or function that joins `tenant_host_configs` with recent `audit_log` events. Create the function `apps/main/src/lib/host-adapters/credential-health.ts` exporting `getTenantCredentialHealth(tenant_id): { status: 'healthy' | 'degraded'; affected_adapters: string[]; banner_message?: string }`.
1. **Re-encryption Inngest job.** Create `apps/main/src/inngest/re-encrypt-old-records.ts`:
- Triggered manually (`event: 'admin.reencrypt_credentials_started'`) AND on a daily cron `cron: '0 6 * * *'` that runs the job if `APP_ENCRYPTION_KEY_PREVIOUS` is set (indicating rotation is mid-flight).
- Job logic:
   1. Find all encrypted records (across `tenant_host_configs.credentials`, plus any other encrypted column added in later prompts — for now, just this one table).
   1. For each record: decrypt with current logic (tries current key, falls back to previous on key_id mismatch).
   1. Re-encrypt with the current key.
   1. Update the row.
   1. Track count of records still at old `key_id`.
- Emits a metric `credentials_at_previous_key_count` per §13.5.3. If this metric is non-zero for more than 7 days after a rotation: log a high-priority warning (alert infra later).
- The job is idempotent: a record already at the current key_id is skipped.
1. **Backup verification helper + MEMORY logging.** Create `apps/main/src/lib/crypto/verify-backup.ts`:
- Exports `verifyBackup({ test_ciphertext_b64: string; expected_plaintext: string; backup_keys: { current: string; previous?: string }, backup_key_ids: { current: string; previous?: string } }): { passed: boolean; reason?: string }`.
- Used by the operator’s quarterly verification process per §13.5.3. The operator restores the backup key set into a sandbox, runs this helper against a known test ciphertext, and asserts `passed: true`.
- **MEMORY.md auto-log:** when verification runs in CI or via an admin endpoint, append an entry to MEMORY.md per §A.X cross-reference: `Backup verification: PASSED on YYYY-MM-DD for key id 'vN'`. The auto-append uses the same MEMORY pattern as other Prompt-completion entries.
- Quarterly cron: `cron: '0 9 1 */3 *'` (1st of every third month at 9am) — emits a reminder event for the operator to perform the verification manually. The cron does NOT itself perform the verification (it would need access to the offsite backup, which by design is NOT in the env vars).
1. **Vercel env var deletion gate (documentation, not code).** §13.5.3 says deleting `APP_ENCRYPTION_KEY_*` env vars without 2FA is gated. Vercel may or may not support this natively. Create `docs/runbooks/encryption-key-management.md` documenting:
- The 2FA requirement when deleting these env vars (or, if Vercel doesn’t support it, the runbook step: “Backup must be verified per §13.5 before deletion is performed”).
- The rotation flow (steps 1-5 from §13.5.1).
- The offsite backup location (operator-filled).
- The quarterly verification schedule.
- Document this runbook in MEMORY.md as a launch-gate item.
1. **Tenant host config UI.** Create `apps/main/src/app/(tenant)/settings/host-integration/page.tsx`:
- Lists available `host_adapters` (active ones).
- For each: shows current config state (verified / pending / rejected / expired / revoked).
- “Connect” / “Re-enter credentials” buttons. Form submits to `POST /api/tenant/host-config` — body includes the adapter ID and a JSON blob of credentials specific to that adapter (each adapter declares its own credential schema as part of its `capabilities`).
- On submit: credentials are encrypted via `encryptCredential` before the DB write. The plaintext never persists.
- Pending verification: the credentials are stored, status=`pending`, and the adapter’s `healthCheck` is invoked. On success, status flips to `verified`.
1. **Tests** under `apps/main/test/integration/host-adapters/` and `apps/main/test/unit/crypto/`:
- Encrypt → decrypt round-trip with current key: returns original plaintext.
- Encrypt with current → rotate keys (set previous = current, current = new) → decrypt: returns plaintext via previous-key fallback.
- Decrypt with unknown key_id: returns `Err({ code: 'unknown_key_id' })`.
- Tamper with one byte of ciphertext: returns `Err({ code: 'auth_tag_mismatch' })`.
- Failure mode 2 simulation: a credential row whose ciphertext is corrupted → `selectAdapter` returns the special always-auth-failed shape → the tenant banner shows the §13.5.4 message → an audit log row appears with the SHA-256 of the corrupted ciphertext.
- Boot validation: setting `APP_ENCRYPTION_KEY_CURRENT` to an invalid base64 string → `verifyEnvAtBoot()` fails. (Test by directly invoking `verifyEnvAtBoot` with a mocked env.)
- Adapter selection flow per §13.7: verified tenant config → tenant’s adapter. No config, sub-host → default + sub-host creds. No config, BYO-host → fallback. Platform → fallback (since fallback is currently the default).
- Re-encrypt job: seed 5 records under previous key id → run the job → all 5 are now under the current key id → metric reads 0.

**Definition of done:**

- All migrations apply; RLS lint gate green.
- Boot fails fast if encryption env vars are misconfigured.
- Encrypt/decrypt unit tests cover all failure modes from §13.5.2.
- Failure-mode-2 integration test produces the right tenant-facing banner.
- The fallback email adapter is seeded as the default and works end-to-end (a test booking submission produces an email to the configured recipient).
- The backup-verification helper exists; the quarterly cron is registered.
- `docs/runbooks/encryption-key-management.md` is committed.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all green.

**After completion:** MEMORY.md entry: (a) the offsite backup location is [operator-fills]; (b) first quarterly verification scheduled for [date]; (c) the fallback email adapter is the platform default for launch — confirm in MEMORY that no real host adapter is being shipped initially and flag the operator decision needed for Phase 1; (d) the §13.5.3 “Vercel env var deletion gate” — note whether it’s enforced via Vercel features or via the runbook discipline only.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

## End of Part 3 build prompts

**After all seven prompts complete, you have:**

- A RAG service that authenticates main-app calls against an explicit shadow tenant table, with a fully fail-closed JWT verification path and a webhook-driven sync with retry queue + nightly reconcile safety net.
- The full retrieval, ingest, and approval API on the RAG side, with the scope-isolation contract verified by integration tests.
- All six personas defined as data, the system-prompt builder composing the three-layer prompt, tenant overrides with Haiku screening, and the two-toggle AI Mode + Background AI configuration model.
- The supervisor’s regen budget, escalation_topics, sampling review queue, kill switch, and a runtime skeleton that exercises the full preflight → action → findings flow. The five “real” preflight checks are stubs awaiting Part 5 §21.10.
- Customer memory schema, extraction Inngest job with the mandatory tenant-scope contract proved out by cross-tenant regression tests, debounce, optimistic locking, the DOB lifecycle, and the 24-hour anonymous→authenticated transfer with deferred-processing-as-undo-mechanism.
- CRM contacts, relationships, pipeline, quotes; host-booking-fee config tables; and the resolved FKs from earlier prompts (`customer_memories.contact_id`, `conversations.contact_id`).
- The `HostAgencyClient` abstraction, encrypted-credential layer with all four §13.5 disaster-recovery controls (offsite backup, quarterly verification, boot validation, gated env-var deletion runbook), and the fallback email adapter seeded as the platform default.

**What’s deferred to later spec parts:**

- Commission math runtime + payouts (Part 4 §14).
- Onboarding flow + Seller of Travel compliance (Part 4 §15).
- Branding (Part 4 §16).
- Authentication flows (Part 4 §17 — though some auth pieces were touched in Prompt 12 for the transfer flow).
- Groups & forum chat (Part 4 §18, Part 5 §19).
- Booking submission via adapters (Part 4 §20).
- RAG consumer-side (chat-time retrieval, hallucination defense — Part 5 §21).
- Content normalization pipeline (Part 5 §22).
- Pre-cruise emails (Part 5 §23).
- Tone matching content (Part 5 §24) — the §24 references in Prompt 10 are TODOs.
- Privacy, security, abuse monitoring (Part 6 §25-§27).
- The five “real” preflight check implementations (Part 5 §21.10).
- The Haiku PII redaction pass in /api/ingest (Part 5 §22.4).

The prompts above add the **AI behavior + customer data + host abstraction** layers on top of Parts 1 & 2’s frame.
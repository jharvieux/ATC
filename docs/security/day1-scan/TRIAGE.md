# Security triage — ATC apps/main + apps/rag (Day-1)

Adversarial triage of `/vuln-scan` candidates. 38 candidates → **14 confirmed real** (1 HIGH, 12 MEDIUM, 1 downgraded to LOW), **16 confirmed LOW / defense-in-depth**, **5 LOW operational / unconfirmed**, **3 false-positive**. The 16 MEDIUM+HIGH candidates each got a dedicated adversarial verifier (votes=1, "scanner is wrong" default, fresh context, source-only); the 22 LOWs were triaged inline against the 16 exclusion rules.

**Triage context:** environment = internet-facing multi-tenant SaaS (HTTP untrusted; authenticated tenant users semi-trusted; cross-tenant + financial integrity are the key threats; rag = internal service, callers are authenticated peers). Scoring = derived HIGH/MED/LOW from preconditions × access. Noise tolerance = precision.

> These are **static** findings. Nothing was executed. For the confirmed HIGH/MEDIUM items, a human-built PoC is the recommended next validation before shipping fixes to prod.

## Confirmed — fix these (ranked)

| rank | id | app | sev | category | file:line | owner | one-line |
|---|---|---|---|---|---|---|---|
| 1 | F-pay-01 | main | **HIGH** | financial-integrity | bookings/[id]/cancel/route.ts:217 | billing | Concurrent booking-cancel double-counts the clawback in `platform_revenue` — settled-payout branch has no CAS gate / no idempotency key (pending branch is guarded; settled is not). Verifier conf 8; confirmed no unique constraint in migration. |
| 2 | F-sm-01 | main | MED | toctou | lib/chat/customer-limit.ts:139 | chat-ai | Customer chat hard-cap is read-modify-write; K concurrent turns at cap−1 all pass → paid-model overrun. Verifier conf 9. |
| 3 | F-sm-02 | main | MED | toctou | lib/chat/anonymous-limit.ts:119 | chat-ai | Anonymous chat limit check+increment non-atomic; N parallel anon requests bypass the free-tier signup wall. Verifier conf 8. |
| 4 | F-sm-03 | main | MED | quota-bypass | lib/ai/call-wrapper.ts:301 | chat-ai | AI-cost hard gate reads a 30s per-instance cache + fire-and-forget transition → bursts overspend the hard ceiling. (D-091 #6.) |
| 5 | F-auth-01 | main | MED | auth-bypass | auth/microsoft-email-prompt/route.ts:25 | platform-auth | Unauthenticated, unthrottled OTP-mint route; per-email attempt cap is defeated by regeneration → email→identity binding to the caller's account. (Fresh code each mint keeps it MED, not HIGH.) |
| 6 | F-leak-01 | main | MED | info-disclosure | chat/route.ts:235 (+460) | chat-ai | Anonymous chat streams raw DB `error.message` via SSE (two sinks: catch at 235-237 and direct interpolation at 460) → schema disclosure to unauth callers. Sibling routes use `dbErrorResponse`; this one doesn't. |
| 7 | F-ssrf-01 | main | MED | ssrf | inngest/travel-news-refresh.ts:48 | integrations | Admin-stored RSS feed URL fetched server-side with full scheme+host control, no allowlist, follows redirects → reaches cloud metadata; response persisted (semi-blind exfil). Platform-admin-gated, env marks it untrusted. |
| 8 | F-tok-02 | main | MED | missing-authz | public/chat/[token]/route.ts:87 | core-app | Public chat token ignores quote/itinerary status (sibling select route enforces it) → declined/expired/forwarded token still loads customer PII into an LLM conversation. |
| 9 | F-rag-pii-02 | rag | MED | unsafe-url | packages/contracts/src/ingest.ts:9 | rag | `source_url`/`image_url` accept `file://`+internal hosts (z.url() only); returned at retrieve and rendered in main app `<img src>`/`<a href>` — one sink (AssetLightbox:44) is unguarded → client-side SSRF / internal probe. (Reclassed: client-side, not server-side SSRF.) |
| 10 | F-rag-wh-01 | rag | MED | auth-ordering | api/feedback/route.ts:60 | rag | Rate-limit runs before HMAC verify, bucket keyed on spoofable `x-forwarded-for` + constant secretHint → unauth attacker exhausts the main app's shared bucket (429s real feedback) + pre-auth Redis writes. (Title "fail-open" is a misnomer — it fails closed; the real bug is auth-ordering.) |
| 11 | F-rag-wh-02 | rag | MED | replay | api/feedback/route.ts:92 | rag | Feedback webhook HMAC covers only the static body (no ts/nonce/dedup) → one captured signed request replays forever to poison chunk retrieval ranking. Sibling routes have a `source_revision` guard; feedback doesn't. |
| 12 | F-tok-01 | main | MED | cost-dos | public/chat/[token]/route.ts:42 | core-app | Public-chat rate limit is per-instance in-memory (resets on cold start, scales with fan-out) → bypassable paid-LLM cost-DoS. Bounded per-tenant by the durable AI hard-cap (keeps it MED, leaning LOW-MED). A durable limiter already exists and isn't wired here. |
| 13 | F-inp-02 | main | MED | unsafe-upload | lib/rag-ingest/extract-content.ts:137 | ingest | Office/PDF parsers fully decompress untrusted uploads before the (post-extraction) output cap → ~50MB OOXML zip-bomb expands to GBs, OOMs the function. Auth-gated, availability-only. The output-cap comment falsely claims to mitigate this. |
| 14 | F-rag-pii-01 | rag | LOW | cost-abuse | packages/contracts/src/ingest.ts:11 | rag | No `.max()` on ingest content. **Downgraded MED→LOW** by verifier: headline path queues to human approval (no spend), per-request cost bounded by OpenAI's 8192-token cap, sync-embed paths are platform-admin-only. Real vector is request *volume* (rate limit), not size. |

## Confirmed LOW / defense-in-depth (real, fix opportunistically)

| id | app | category | file:line | owner | note |
|---|---|---|---|---|---|
| F-leak-02 | main | info-disclosure | tenant/ai-config/cost-projection/route.ts:40 | core-app | Raw DB `error.message` echoed to authenticated caller (also rag/submit/batch:70 = F-leak-03, help/* routes). Centralize via `dbErrorResponse`. |
| F-leak-03 | main | info-disclosure | rag/submit/batch/route.ts:70 | ingest | Same class as F-leak-02. |
| F-sm-04 | main | state-machine | quote-options/[id]/select/route.ts:62 | core-app | Quote `accepted` transition has no source-state guard → can resurrect a cancelled/expired quote. Intra-tenant. |
| F-iso-01 | main | idor | bookings/[id]/line-items/route.ts:50 | core-app | line-item POST doesn't verify parent booking ownership (sibling resources route was hardened #715). tenant_id injected → no cross-tenant read, but dangling-FK / commission pollution. |
| F-iso-02 | main | idor | crm/contacts/[id]/relationships/route.ts:54 | core-app | relationship POST doesn't verify contact ownership → foreign-UUID existence oracle + relationship pollution. |
| F-tok-03 | main | broken-authz | public/quote/[token]/select/route.ts:40 | core-app | quote_options query not tenant-scoped (single-layer; bounded by quote_id match). Add `.eq('tenant_id',…)`. |
| F-tok-04 | main | missing-expiry | lib/email/unsubscribe-token.ts:91 | integrations | Unsubscribe HMAC token never expires (companion tokens do). Low impact (suppression toggle). |
| F-pay-03 | main | money-integrity | lib/import/promote.ts:323 | billing | Float `Math.round` commission math bypasses money.ts. Dormant (subhost payable hard-coded 0); becomes live if sub-host imports ship. |
| F-adm-01 | main | missing-audit | admin/tenants/route.ts:26 | platform | Two admin GET routes read cross-tenant via raw service-role without the audit wrapper → no forensic trail on key compromise. |
| F-auth-02 | main | missing-authz | proxy.ts:195 | platform | Proxy admin gate is a cookie shape-check; all 54 routes assert today, but a future admin route without an in-handler assertion is exposed. Add a CI guard (like check:permission-matrix). |
| F-rag-pii-04 | rag | pii-leak | lib/pii/regex-prefilter.ts:84 | rag | Zero-tolerance PII prefilter misses separator variants (dotted/no-sep SSN/CC) → defeats the guarantee. Normalize before matching. |
| F-rag-iso-01 | rag | tenant-isolation | api/retrieve/route.ts:40 | rag | Primary vector path is DB-only single-layer; correct today but the one critical path lacks the JS re-filter backstop the others have. Add it. |
| F-rag-auth-01 | rag | jwt-verify | lib/auth/verify-service-jwt.ts:120 | rag | Service JWT verified without aud/iss binding. No current bypass; add as defense-in-depth. |
| F-rag-auth-02 | rag | missing-authz | api/admin/purge-tenant-scoped-chunks/route.ts:15 | rag | Destructive admin routes gate on `service_identifier` but not `scope==='write'` → a read-scoped platform-admin token can delete. Add the scope check. |
| F-rag-wh-03 | rag | hmac | api/feedback/route.ts:41 | rag | Hand-rolled string timingSafeEqual with early length-return; use crypto.timingSafeEqual like the sibling routes. |

## LOW — operational / unconfirmed (track, not security-critical)

| id | app | file:line | disposition |
|---|---|---|---|
| F-wh-01 | main | webhooks/resend/route.ts:28 | Real but **not attacker-triggerable** (valid Svix sig required); re-delivery re-enqueues retry jobs. Operational reliability, not security. Add dedup like Stripe. |
| F-wh-03 | main | webhooks/gmailpubsub/route.ts:142 | Same: history-pointer-after-loop reprocessing; not attacker-triggerable. Confirm processGmailInboundMessage idempotency. |
| F-wh-02 | main | lib/stripe/webhook-handler.ts:414 | Deliberate error-path row delete; relies on per-handler idempotency. Confirm every branch is replay-safe. |
| F-inp-01 | main | lib/supervisor/checks/arithmetic-check.ts:20 | ReDoS not confirmed (operator-separated tokens prevent exponential; bounded by max_tokens). `needs_manual_test` — add a bounded-time test + length cap. |
| F-auth-03 | main | auth/transfer-session/route.ts:92 | Requires knowing an unguessable anon-session UUID (rule 15-adjacent). Bind commit to the originating cookie. |
| F-ssrf-02 | main | lib/external/cruisemapper/diy-fetcher.ts:76 | Host is operator/env-controlled (not tenant); only an upstream-compromise redirect reaches internal. Apply the same guard as F-ssrf-01. |

## False positives (no action)

| id | app | rule | why |
|---|---|---|---|
| F-pay-02 | main | 16 / 13 | Commission state-machine CAS: all production callers transition to the *same* terminal value (`waived`), no divergent concurrent writer exists; the real money race is the un-CAS'd payout branch — already captured as **F-pay-01**. A status CAS here is hardening, not the fix. |
| F-rag-pii-03 | rag | 6 | "Untrusted-tagging missing in retrieve contract" — the harm is realized only in the downstream LLM caller (main app), and the contract already carries scope/source_type/authority. Prompt-injection input → not a code vuln in RAG. |
| F-inp-03 | main | 7 | Storage-path `startsWith` traversal: Supabase Storage treats `..` as a literal key segment (flat S3-style keyspace), so `../` doesn't escape the tenant prefix. Object-storage traversal exclusion. (One-line hardening: still reject `..` for clarity.) |

## Themes (for fix sequencing)

1. **Non-atomic counters / CAS gaps** (F-pay-01, F-sm-01, F-sm-02, F-sm-03, F-sm-04): read-modify-write where a DB-atomic increment or status-CAS is needed. The codebase already has `safeAwaitRowCount` and `increment_tenant_ai_cost` — apply the existing pattern.
2. **Per-instance / in-memory limits** (F-tok-01, F-sm-*, F-rag-wh-01): move to the shared Redis limiter; a durable customer limiter already exists.
3. **Raw DB error.message egress** (F-leak-01/02/03): centralize through `dbErrorResponse`; pin with a test.
4. **URL/SSRF input validation** (F-ssrf-01, F-rag-pii-02, F-ssrf-02): one shared scheme/host allowlist guard for every variable-host fetch and stored-then-rendered URL.
5. **Webhook replay/idempotency** (F-rag-wh-02, F-wh-01/02/03): signed timestamp+nonce / dedup rows.

**Next:** `/patch TRIAGE.json` for inert candidate diffs on the confirmed findings.

# Threat Model: ATC apps/main (AI Travel Concierge — platform app)

## 1. System context

`apps/main` is the customer- and tenant-facing application of a multi-tenant AI travel-concierge SaaS. It is a Next.js 16 (App Router, TypeScript) application deployed on Vercel, backed by Supabase (Postgres + Auth + RLS), Stripe (platform billing + Connect payouts), Inngest (80+ background jobs), Resend (email), a GitHub App (customer bug intake), Redis (rate limits/cache), and OpenAI/Anthropic for LLM features. It exposes ~258 API routes plus middleware (`proxy.ts`) that resolves a tenant from the request Host/subdomain/session and injects `x-resolved-tenant-id`.

Tenancy is the core security property: many tenants share one database, isolated by a documented four-layer model — (1) Supabase JWT identity, (2) tenant-context resolution, (3) RBAC + session-age gates (`assertPermission`, `assertPlatformAdmin`), and (4) DB-layer RLS auto-scoping via a `tenantClient(ctx)` proxy, with the RLS-bypassing service-role client confined to platform-admin paths behind `withPlatformAdminAudit`. The repo is unusually security-instrumented: a cross-tenant probe test (any 2xx with wrong-tenant creds fails the build), an RLS snapshot diff, a permission-matrix gate, a 14-item D-091 anti-pattern catalog enforced by ESLint + a PR review agent, and a CVE gate. This threat model maps where untrusted input enters and where privilege changes, so `/vuln-scan` can be scoped to the surfaces that matter most.

## 2. Assets

| asset | description | sensitivity |
|---|---|---|
| Contact/passenger PII | names, emails, phones, DOB, passport numbers (encrypted), nationality, preferences | critical |
| Cross-tenant isolation integrity | the property that tenant A cannot read/write tenant B's rows | critical |
| Payment & payout data | commissions, payout balances/ledgers, Stripe transfer IDs, amounts (cents) | critical |
| Conversation/chat content | customer↔AI messages, supervisor findings, injected RAG context | critical |
| Bookings & reservations | cruise/sailing details, cabins, status lifecycle, provider refs | critical |
| Customer memories | extracted preferences, family, travel history, important dates | critical |
| Secrets & credentials | service-role key, Stripe/Resend/AI keys, Inngest signing key, JWT signing key, GH App key, `MAIN_APP_ADMIN_API_KEY`, `CRON_SECRET` | critical |
| Encrypted tenant credentials | host-adapter creds + Gmail OAuth refresh tokens (AES-256-GCM) | critical |
| Auth/session integrity | Supabase session/JWT, anon-session identity, service_role separation | critical |
| Platform-admin authority | `platform_admins` membership, admin API authority | critical |
| Tenant business data | tier/billing config, legal name/address, compliance status | high |
| RAG knowledge base | tenant-submitted docs, chunks, embeddings, approval state | high |
| Audit & forensics logs | admin-action audit, forensic snapshots (disputes, complaints) | high |
| AI quota/budget state | per-tenant spend caps, cost accumulation, kill switches | high |
| Email log & suppressions | delivery/bounce/complaint records, unsubscribe state | high |
| Forum/group content | threads, messages, group invitations (HMAC tokens) | high |
| Custom-domain config | branding + DNS verification state machine | high |
| Abuse signals | per-tenant abuse counters + enforcement state | high |
| Anon session data | session IDs, IPs, device fingerprints (rate limiting) | medium |
| Quotes / personas / price-watch | pricing quotes, persona overrides, watch subscriptions | medium |

## 3. Entry points & trust boundaries

| entry_point | description | trust_boundary | reachable_assets |
|---|---|---|---|
| Tenant-scoped REST routes (`/api/bookings`, `/api/crm`, `/api/forums`, `/api/payouts`, `/api/rag`, …) | authenticated CRUD, RBAC + tenant scope | auth JWT → tenant RLS scope | contact PII, bookings, payments, conversation, RAG, forum content, cross-tenant integrity |
| Middleware `proxy.ts` | Host/subdomain→tenant resolution, payment gate, admin gate | untrusted Host header → tenant context | cross-tenant integrity, tenant business data |
| `/api/admin/*` | platform-admin surface; `MAIN_APP_ADMIN_API_KEY` bearer (constant-time) OR session+`platform_admins` | unauth HTTP + shared secret → cross-tenant authority | platform-admin authority, all tenant data, secrets |
| Webhooks: Stripe platform/connect, Resend (Svix), GitHub (HMAC), Gmail Pub/Sub | external callbacks mutating payment/email/bug state | untrusted external → DB mutations | payments/payouts, email log, bookings, cross-tenant lookup |
| OAuth: `/api/auth/oauth-initiate`, `/api/auth/callback`, `/api/auth/transfer-session` | PKCE OAuth, session issuance | untrusted query (code/state/nonce) → JWT issuance | auth/session integrity |
| Inngest `/api/inngest` (80+ fns) | background jobs run with service-role + admin context | Inngest SDK signature → privileged transitions | all tenant data, payouts, tenant lifecycle, secrets |
| Cron `/api/cron/*` (12+) | scheduled jobs; `CRON_SECRET` bearer | shared secret → privileged batch work | payments, bookings, abuse state, email |
| File upload (`/api/imports/upload`, `/api/rag/submit/file`) | PDF/CSV/Office ingestion, magic-byte check | authenticated upload → parser + storage | RAG knowledge, bookings, contact PII |
| Public token surfaces: `/api/public/chat/[token]`, `/api/public/quote/[token]`, `/api/email/unsubscribe`, GDPR export/delete tokens | unauthenticated, token-gated (SHA256/HMAC-signed) | untrusted URL token → scoped resource | conversation, quotes, contact PII, email suppressions |
| Public unauth: `/api/extension/config`, `/api/tenants/slug-check`, `/api/legal/*`, `/api/security/csp-report`, `/api/health` | anonymous endpoints | unauth HTTP → config/telemetry | secrets (NEXT_PUBLIC keys), tenant enumeration |
| Chat `/api/chat`, `/api/public/chat` | anon + auth chat → LLM | untrusted prompt → LLM + RAG + tools | conversation, AI budget, RAG content |
| Custom-domain verification + outbound fetch (DNS check, RAG URL ingest, Apify) | server-initiated outbound requests | tenant-controlled URL/host → server fetch | SSRF target (internal metadata), RAG content |
| Supply chain: lockfiles, GitHub Actions secrets, Vercel env | build/deploy identity & secrets | CI/CD → prod credentials | all secrets, prod DB, Vercel project |

## 4. Threats

| id | threat | actor | surface | asset | impact | likelihood | status | controls | evidence |
|---|---|---|---|---|---|---|---|---|---|
| T1 | Cross-tenant data exposure via service-role path missing the tenant-scope layer (under-registered table, ad-hoc service-role query, raw `.rpc()` not proxied) | remote_auth | Tenant-scoped REST routes; Inngest | cross-tenant integrity, contact PII, payments | critical | possible | partially_mitigated | tenantClient proxy + fail-closed UnregisteredTenantTableError; RLS; cross-tenant probe test; service-role lint | |
| T2 | Cross-tenant read/write via IDOR on `[id]` resource routes when the row's tenant isn't re-checked against caller context | remote_auth | Tenant-scoped REST routes | bookings, contact PII, payments, conversation | critical | possible | partially_mitigated | RLS + assertPermission; two-layer isolation rule (D-091 #4) | |
| T3 | Full platform-admin takeover via leaked/guessed `MAIN_APP_ADMIN_API_KEY` bearer | supply_chain | `/api/admin/*` | platform-admin authority, all tenant data, secrets | critical | possible | partially_mitigated | constant-time compare; alternative session+platform_admins path; audit logging | |
| T4 | Payment/payout state manipulation via webhook signature bypass or wrong-encoding verification | remote_unauth | Stripe/Resend/GitHub/Gmail webhooks | payments/payouts, email log | critical | possible | partially_mitigated | per-provider signature verify; idempotency rows; recorded-signature fixture rule (D-091 #12) | |
| T5 | Payout double-spend / clawback corruption via zero-row CAS or idempotency-before-dispatch on financial mutations | remote_auth | payouts routes; Stripe webhooks; reconcile cron | payment & payout data | critical | possible | partially_mitigated | safeAwaitRowCount CAS guards; idempotency-after-dispatch rule (D-091 #7/#10) | |
| T6 | Authentication bypass / session fixation via OAuth callback mishandling `state`/`nonce`/PKCE or open-redirect on return path | remote_unauth | OAuth callback | auth/session integrity | critical | possible | partially_mitigated | PKCE; reauth flow; prior state-clobber fix (#438) | #438 |
| T7 | Arbitrary privileged background work via leaked Inngest signing key (trigger tenant termination, CCPA purge, kill-switch) | supply_chain | Inngest | tenant lifecycle, all tenant data, secrets | critical | rare | partially_mitigated | Inngest SDK signature; secrets in Vercel/GH env; no per-fn app auth | |
| T8 | PII / secret disclosure via verbose error messages or log injection reaching logs/responses | remote_auth | Tenant-scoped REST routes; webhooks | contact PII, secrets, audit integrity | high | likely | partially_mitigated | CR/LF log sanitization (#1366); some inline DB-error early-returns still echo `*.message` (#1125) | #1366, #1125 |
| T9 | SSRF via tenant-controlled URL in custom-domain verification, RAG URL ingestion, or outbound integrations | remote_auth | custom-domain verify; RAG ingest; outbound fetch | internal metadata/creds, RAG integrity | high | possible | unmitigated | none verified (need allowlist/IP-block check) | |
| T10 | Abuse of token-gated public surfaces via guessable/replayable/expired tokens (public chat, quote, GDPR, unsubscribe) | remote_unauth | Public token surfaces | conversation, quotes, contact PII | high | possible | partially_mitigated | SHA256/HMAC-signed tokens; some in-memory-only rate limits | |
| T11 | Privilege/scope escalation via state-machine transition trusting caller-supplied target (`body.target_stage`, booking/tenant status) | remote_auth | Tenant-scoped REST routes; Inngest | bookings, tenant business data | high | possible | partially_mitigated | transition validation rule (D-091 #11) | |
| T12 | Stored XSS / prompt-injection via user content (forum, RAG, chat, persona) reaching other users or steering the AI/tools | remote_auth | forums; RAG; chat | conversation, RAG integrity, contact PII | high | possible | partially_mitigated | CSP; React escaping; RAG PII quarantine | |
| T13 | AI cost / quota exhaustion via TOCTOU on spend gates or concurrent crons double-spending | remote_auth | chat; Inngest; cron | AI quota/budget state, service availability | medium | likely | partially_mitigated | quota re-read rule (D-091 #6); kill switches | |
| T14 | Denial of service / ReDoS via unbounded input to regex or parsers (email, uploads, import) | remote_unauth | chat; file upload; auth | service availability | medium | likely | partially_mitigated | email regex hardened + 254-char cap (#1366); magic-byte checks | #1366 |
| T15 | Secret leakage via `/api/extension/config` or env bleed into the client bundle | remote_unauth | Public unauth | secrets (keys) | medium | possible | partially_mitigated | only NEXT_PUBLIC_* intended public; needs verify no service secret exposed | |
| T16 | Cron forgery / replay via leaked `CRON_SECRET` (single shared token, no per-route key) | supply_chain | Cron | payments, bookings, abuse state | medium | rare | partially_mitigated | CRON_SECRET bearer; Vercel-signed schedule | |
| T17 | Tenant enumeration / timing oracle via `slug-check`, `tenant_is_active` RPC, or login responses | remote_unauth | Public unauth; middleware | tenant business data | low | likely | risk_accepted | caller-scoped booleans (D-295); unguessable UUIDs | D-295 |
| T18 | Supply-chain compromise via malicious dependency or stolen GitHub Actions secrets → prod DB/Vercel | supply_chain | Supply chain | all secrets, prod DB | critical | rare | partially_mitigated | prod-deploy env approval; CVE gate; bounded overrides; no auto-rotation | |
| T19 | Silent cross-tenant exposure from undetected RLS/grants drift (manual prod change) | insider | Supply chain; DB | cross-tenant integrity | high | rare | partially_mitigated | nightly prod-drift-check (≤24h lag, email-only) | |

## 5. Deprioritized

| threat | reason |
|---|---|
| Spoofing of Vercel cron source | Vercel signs/delivers cron requests on the declared schedule; residual risk is secret leak (covered by T16) |
| Repudiation of admin actions | `withPlatformAdminAudit` writes via a separate client that survives rollback; destructive ops require `reason_detail` |
| SECURITY DEFINER RPC direct execution | risk-accepted in D-295 (caller-scoped booleans, no cross-user leak); revoking breaks RLS |
| Native memory corruption | managed-runtime (TS/Node) target; not applicable |
| Tenant enumeration via slug-check | low impact; slugs are semi-public by design (covered as T17, accepted) |

## 6. Open questions

- Is `/api/extension/config` confirmed to expose only `NEXT_PUBLIC_*` values, never a service secret? (T15)
- Do custom-domain DNS verification and RAG URL ingestion enforce an SSRF allowlist / block link-local + cloud-metadata IPs? (T9)
- Are public-surface rate limits (public chat/quote) backed by Redis or only in-memory per-instance (bypassable across regions)? (T10)
- Are the inline DB-error early-returns that echo `*.message` (#1125) reachable by an unauthenticated/cross-tenant caller? (T8)
- Is there a WAF / upstream size limit in front of upload and chat endpoints? (T14)
- Does any Inngest function trust `event.data` for tenant_id without re-deriving it from a trusted source? (T1/T7)

## 7. Provenance

- mode: bootstrap
- date: 2026-06-23
- target: apps/main @ a1deac27
- inputs: git-log + CHANGELOG/MEMORY mined (no --vulns file)
- owner: unset

## 8. Recommended mitigations

| mitigation | threat_ids | closes_class | effort |
|---|---|---|---|
| Enforce SSRF allowlist + link-local/metadata IP block on all server-initiated outbound fetches | T9 | yes | M |
| Centralize API error responses through a sanitizer that never echoes DB `*.message` to clients/logs | T8 | yes | M |
| Back all public/anon rate limits with Redis (shared across regions), not in-memory | T10,T13,T14 | partial | M |
| Re-derive tenant_id from trusted context in every Inngest function; never trust `event.data.tenant_id` | T1,T7,T11 | partial | M |
| Assert affected-row count on every status-guarded financial CAS update | T5 | yes | S |
| Add per-route/per-function secrets or rotate `MAIN_APP_ADMIN_API_KEY`/`CRON_SECRET` on a schedule | T3,T16 | partial | M |
| Add a recorded-signature fixture test for each webhook provider (encoding pinned) | T4 | partial | S |
| Escalate RLS/grants drift detection beyond email (block-on-drift or page) | T19 | partial | S |

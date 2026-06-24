# Threat Model: ATC apps/rag (RAG ingestion & retrieval service)

## 1. System context

`apps/rag` is the retrieval-augmented-generation backend for the AI travel-concierge platform: a separate Next.js + Supabase service (its own Supabase project and `SUPABASE_RAG_SERVICE_ROLE_KEY`) that ingests tenant- and platform-submitted knowledge, embeds it (OpenAI), stores chunks/embeddings, and serves similarity retrieval to the main app's AI layer. It is a service-to-service backend: callers authenticate with an RS256 service JWT (`withServiceAuth`, scope `read`/`write`, `service_identifier`), and inbound platform events arrive as HMAC-signed webhooks (`RAG_WEBHOOK_SECRET`). It runs ~24 routes: `ingest*`, `retrieve`, `approve/{tenant,global}`, `feedback`, `tenant-events`, `platform-settings-events`, `itinerary`, `admin/*` (purge, export, authority-override, demote, replace, post-termination, counts, media-assets), `inngest`, and `health`.

The core security property is the same as the main app: per-tenant isolation of knowledge chunks and embeddings, enforced both by a JWT `tenant_id`↔`body.tenant_id` binding and a two-layer query filter (DB `.or(scope=global, tenant_id=ctx)` predicate + a JS re-filter). Because RAG holds free-text user submissions and serves them back to an LLM, PII handling and prompt-injection surface are first-class concerns. The service is fail-closed on JWT verification (Redis jti replay cache + tenant-shadow lookup) and uses timing-safe HMAC + stale-revision guards on webhooks.

## 2. Assets

| asset | description | sensitivity |
|---|---|---|
| Cross-tenant retrieval isolation | tenant A must not retrieve tenant B's chunks/assets | critical |
| Knowledge chunk content | user/reference free text; may contain PII | high |
| Chunk embeddings | vector form of content; can leak patterns even if text redacted | high |
| Service JWT keys | `SERVICE_JWT_PUBLIC_KEY(_PREVIOUS)` (verification), kid mapping | critical |
| `RAG_WEBHOOK_SECRET` | HMAC secret for feedback/tenant-events/platform-settings | critical |
| `SUPABASE_RAG_SERVICE_ROLE_KEY` | full DB access to the RAG project | critical |
| `OPENAI_API_KEY` | embedding API; per-tenant billable cost | critical |
| `INNGEST_SIGNING_KEY` | authenticates background-job invocation | critical |
| Redis jti/replay + rate-limit state | anti-replay + abuse control | high |
| rag_media_assets | media metadata + URLs (scope global/tenant) | medium |
| Authority scores / overrides | influence retrieval ranking | medium |
| tenant_registry_shadow / platform_settings | replicated tenant status + feature flags | medium |
| rag_retrieval_log / feedback events | query analytics, ranking signals | low |

## 3. Entry points & trust boundaries

| entry_point | description | trust_boundary | reachable_assets |
|---|---|---|---|
| `POST /api/retrieve` | similarity search, scope=tenant | service JWT (tenant_id must match body) → chunk store | chunk content, embeddings, media assets, cross-tenant isolation |
| `POST /api/ingest`, `/ingest/itinerary`, `/ingest/reference` | enqueue/insert knowledge; global requires `service_identifier=platform-admin` | service JWT → ingestion queue/chunks | chunk content, cross-tenant isolation |
| `POST /api/approve/{tenant,global}` | approve queued items → embed + insert | service JWT (tenant) / platform-admin (global) → chunks + OpenAI | chunk content, embeddings, OPENAI_API_KEY (cost) |
| `POST /api/feedback` | thumbs feedback → ranking factor | HMAC (`RAG_WEBHOOK_SECRET`) + rate limit | feedback events, ranking |
| `POST /api/tenant-events`, `/platform-settings-events` | replicate tenant status / settings | HMAC + stale-revision guard | tenant_registry_shadow, platform_settings |
| `POST /api/admin/*` | purge/export/authority/demote/replace/post-termination/counts/media | service JWT + `service_identifier=platform-admin` | chunks (destructive), cross-tenant isolation |
| `GET /api/itinerary` | read itinerary chunks, scope=read | service JWT (read) | chunk content |
| `GET/POST /api/inngest` | background jobs (sync, embedding flush, promo state, reconcile) | Inngest HMAC signing key | all tables |
| `GET /api/health`, `/health/ready` | liveness/readiness | none | none |

## 4. Threats

| id | threat | actor | surface | asset | impact | likelihood | status | controls | evidence |
|---|---|---|---|---|---|---|---|---|---|
| T1 | Cross-tenant retrieval/ingest leakage if the tenant_id binding or two-layer scope filter is bypassed in a refactor or a new query path | remote_auth | retrieve; ingest; approve | cross-tenant isolation, chunk content | critical | possible | partially_mitigated | JWT tenant binding; DB `.or()` + JS re-filter; tests (#743) | #743, #395 |
| T2 | Destructive cross-tenant admin op (purge/export/demote) via a mis-issued or over-scoped platform-admin JWT | remote_auth | admin/* | chunks (destructive), cross-tenant isolation | critical | rare | partially_mitigated | `service_identifier=platform-admin` gate on all 10 admin routes (#167/#1249) | #167, #394 |
| T3 | Forged feedback/tenant/settings events via leaked `RAG_WEBHOOK_SECRET` (manipulate ranking, toggle tenant status, change flags) | remote_unauth | feedback; tenant-events; platform-settings | ranking, tenant_registry_shadow, platform_settings | high | rare | partially_mitigated | timing-safe HMAC; rate limit; stale-revision guard | |
| T4 | Tolerable-PII (names/emails/phones) stored unredacted in chunks and returned at retrieval | remote_auth | ingest; approve; retrieve | chunk content (PII) | high | likely | partially_mitigated | zero-tolerance prefilter (passport/SSN/CC) only; Haiku redaction is TODO (§22.4) | |
| T5 | Prompt injection via ingested content surfaced verbatim to the downstream LLM ("ignore previous instructions…") | remote_auth | ingest; retrieve | conversation integrity (downstream) | high | possible | unmitigated | none in RAG (delegated to main-app LLM caller) | |
| T6 | JWT replay when the Redis jti cache is unavailable | remote_auth | all service-JWT routes | cross-tenant isolation, chunk content | high | rare | mitigated | fail-closed: Redis unreachable → 503 reject | |
| T7 | Unauthenticated background-job invocation if `INNGEST_SIGNING_KEY` is unset in prod | remote_unauth | inngest | all tables | critical | rare | mitigated | boot-time throw if key absent in production (2026-05-25 Finding 5) | |
| T8 | SSRF / local-file disclosure via `source_url` stored verbatim (`file://`, internal host) and returned in retrieval results | remote_auth | ingest*; retrieve | internal data exposure (at render) | medium | possible | unmitigated | URL not fetched server-side, but no scheme/host validation; rendered by clients | |
| T9 | Embedding-cost inflation / DoS via large-batch ingest with no size cap | remote_auth | ingest; approve | OPENAI_API_KEY cost, availability | medium | possible | partially_mitigated | per-tenant cost logging; OpenAI Batch path; no hard bulk-size cap | |
| T10 | Rate-limit fail-open on `/api/feedback` in non-production (misconfigured NODE_ENV) | remote_unauth | feedback | ranking integrity | medium | possible | partially_mitigated | prod enforces (Redis-down → 500); non-prod fails open with warn | |
| T11 | Authority-score manipulation steering retrieval ranking via tenant-controlled content | remote_auth | ingest; approve/tenant | ranking integrity | low | rare | partially_mitigated | authority sourced from review pipeline, not tenant input; admin override audited | |
| T12 | Stale-revision overwrite of platform_settings/tenant status if upstream revisions aren't monotonic | supply_chain | platform-settings-events; tenant-events | platform_settings, tenant status | medium | rare | partially_mitigated | per-key stale-revision guard (relies on upstream monotonic counter) | |
| T13 | Service-role / OpenAI key compromise → full RAG DB access or cost abuse | supply_chain | env / all routes | service-role key, chunk store | critical | rare | partially_mitigated | env isolation; separate RAG project limits blast radius; manual rotation | |

## 5. Deprioritized

| threat | reason |
|---|---|
| Native memory corruption | managed TS/Node runtime; not applicable |
| RLS bypass on service-role queries | by design service-role bypasses RLS; isolation is enforced in app-layer two-layer filter (covered by T1) |
| Unauth read of `/api/health*` | no assets reachable |

## 6. Open questions

- Is `source_url` ever fetched server-side anywhere downstream (main app render, screenshotting, link preview)? If so, T8 escalates from medium to high. (T8)
- What is the planned timeline/owner for the §22.4 Haiku tolerable-PII redaction pass? Until then T4 is live. (T4)
- Are there hard per-request / per-tenant caps on ingest batch size and embedding volume? (T9)
- Does the main app guarantee monotonic `source_revision` per settings key and per tenant event? (T12)
- Is any RAG admin route reachable with a JWT whose `service_identifier` is attacker-influençable, or is it strictly issued by the main app? (T2)

## 7. Provenance

- mode: bootstrap
- date: 2026-06-23
- target: apps/rag @ a1deac27
- inputs: git-log + code mined (no --vulns file)
- owner: unset

## 8. Recommended mitigations

| mitigation | threat_ids | closes_class | effort |
|---|---|---|---|
| Ship the §22.4 tolerable-PII redaction pass before retrieval return; treat retrieval as a PII egress point | T4 | yes | M |
| Validate `source_url` scheme/host on ingest (allowlist http/https, block file:/internal) and mark untrusted at retrieval | T8 | yes | S |
| Add a single tenant-scope assertion helper used by every chunk/asset query so a new query path can't skip it | T1 | partial | M |
| Tag RAG-returned chunks as untrusted and require the main-app LLM caller to wrap them in a prompt-injection guard | T5 | partial | M |
| Hard-cap ingest batch size and per-tenant embedding volume; reject oversized requests | T9 | yes | S |
| Make the feedback rate-limit fail-closed in all envs (or assert NODE_ENV at boot) | T10 | partial | S |

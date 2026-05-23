# Env-Var Audit — BP29 Task 1

Cross-reference between TechSpec §28 (canonical) and the actual env-var
surface in code as of `feature/bp29-env-vars` (post-BP28 merge).

**Method:**
- Walked `specs/TechSpec/section-28-environment-variables-reference.html` §28.1–§28.17.
- Walked `apps/main/src/lib/env.ts` (the existing Zod schema; built up across BPs 01–28).
- Walked `apps/rag/src/lib/env.ts`.
- `grep -rE 'process\.env\.[A-Z_]+'` across `apps/main/src` and `apps/rag/src` to find any bypass references.

**Legend:**
- ✅ match — spec name + code name agree, code already validates.
- ⚠️ naming-drift — spec and code refer to the same concept but with different names.
- 🆕 missing-from-code — spec lists as required-at-boot or important, code does not declare it.
- 📦 code-only — code declares it (legitimate addition for feature-specific behavior), spec does not list it (most are sub-section thresholds covered by §28.16/§28.17 "code constants").
- 🚧 process.env-bypass — code reads `process.env.X` directly without going through `env()`. Should be added to the schema OR explicitly justified.

---

## §28.1 — Platform Identity & Routing

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `PLATFORM_PRIMARY_DOMAIN` | `PLATFORM_PRIMARY_DOMAIN` | ✅ | required, `.min(1)` — spec wants `.url()`-ish but it's a bare domain (no scheme), keep current. |
| `PLATFORM_TENANT_SUBDOMAIN_BASE` | — | 🆕 | Spec required. Code derives subdomains via `PLATFORM_DOMAIN_REGEX` instead. Need to either add this var or document the regex-based equivalence. |
| `PLATFORM_RAG_SUBDOMAIN` | `RAG_SERVICE_URL` | ⚠️ | Spec wants subdomain; code uses full URL. Equivalent surface — add a `RAG_SERVICE_URL`-as-canonical note in spec follow-up. |
| `PLATFORM_ADMIN_DOMAIN` | — | 🆕 | Spec optional. Not yet wired. |
| `NEXT_PUBLIC_PLATFORM_BRAND_NAME` | — | 🆕 | Spec required. Hardcoded today in templates; not yet wired through env. |
| `NEXT_PUBLIC_PLATFORM_SUPPORT_EMAIL` | — | 🆕 | Spec required. Same as above. |
| `NODE_ENV` | `NODE_ENV` | ✅ | code: `enum(["development","test","production"])`; spec: `development/staging/production`. **Naming drift on values** — `test` (code) vs `staging` (spec). |
| `VERCEL_ENV` | — (`PLATFORM_ENV`) | ⚠️ | Spec lists `VERCEL_ENV` auto; code uses `PLATFORM_ENV` for the same role. |
| — | `PLATFORM_DOMAIN_REGEX` | 📦 | Tenant resolver. |
| — | `GIT_COMMIT_SHA` | 📦 | Telemetry. |

## §28.2 — Supabase Main

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `NEXT_PUBLIC_SUPABASE_URL` | ✅ | `.url()`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | `.min(1)`. |
| `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` | ✅ | `.min(1)`; spec wants `.min(40)`. |
| `SUPABASE_JWT_SECRET` | — | 🆕 | Spec required. Code uses Supabase Auth's built-in verification, not this directly. Add as `.optional()` with note. |
| `SUPABASE_DB_URL` | — | 🆕 | Spec required for migration role. Migrations run through CI workflow that has its own connection string. Add as `.optional()` (CI/operator env). |

## §28.3 — Supabase RAG

| Spec name | Code name (RAG service) | Status | Notes |
|---|---|---|---|
| `RAG_SUPABASE_URL` | `SUPABASE_RAG_URL` | ⚠️ | Different prefix order. Code uses `SUPABASE_RAG_*` to keep Supabase-prefixed names co-located in shared `.env.local`. |
| `RAG_SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_RAG_SERVICE_ROLE_KEY` | ⚠️ | Same. |
| `RAG_SUPABASE_DB_URL` | — | 🆕 | Spec required (migration role). RAG migrations run through their own CI workflow. |
| — | `SUPABASE_RAG_ANON_KEY` | 📦 | Code requires for client-side reads if any. |

## §28.4 — Inter-Service Auth — **MAJOR NAMING DRIFT**

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `INTER_SERVICE_JWT_PRIVATE_KEY` | `SERVICE_JWT_PRIVATE_KEY` | ⚠️ | Drop `INTER_` prefix in code. Renaming touches: env.ts, RAG env.ts, all JWT signing/verify call sites, GitHub Actions workflow env, Vercel project env vars (operator). |
| `INTER_SERVICE_JWT_PUBLIC_KEY` | `SERVICE_JWT_PUBLIC_KEY` | ⚠️ | Same. |
| `INTER_SERVICE_JWT_PUBLIC_KEY_PREVIOUS` | — | 🆕 | Code uses `SERVICE_JWT_ACCEPTED_KEY_IDS` (a comma-separated kid allowlist) for rotation overlap — semantically equivalent but spec wants an explicit `_PREVIOUS` var. |
| `INTER_SERVICE_JWT_KEY_ID` | `SERVICE_JWT_KEY_ID` | ⚠️ | Same. |
| `INTER_SERVICE_JWT_TTL_SECONDS` | — | 🆕 | Spec optional, default 300. Code: hardcoded 300 in signer. Add. |
| `INTER_SERVICE_JTI_CACHE_URL` | `REDIS_URL` | ⚠️ | Spec wants explicit `INTER_SERVICE_JTI_CACHE_URL`; code uses generic `REDIS_URL`. Possibly intentional (one Redis serves multiple purposes). |

**Scope flag:** Renaming `SERVICE_JWT_*` → `INTER_SERVICE_JWT_*` is a multi-touch change with operator-side env var renames in CI + Vercel. Bring to user before acting.

## §28.5 — Anthropic

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | ✅ | code: `.optional()`; spec required. Tighten + add `.startsWith('sk-ant-')`. |
| `ANTHROPIC_SONNET_MODEL` | — | 🆕 | Spec required. Code hardcodes model strings at call sites. Add. |
| `ANTHROPIC_HAIKU_MODEL` | — | 🆕 | Same. Code has feature-specific `CHAT_HAIKU_MODEL`, `ENTITY_EXTRACTION_MODEL`, etc. — those could default to `ANTHROPIC_HAIKU_MODEL` if unset. |
| `ANTHROPIC_PROMPT_CACHE_ENABLED` | — | 🆕 | Spec optional default true. Add. |

## §28.6 — OpenAI

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | `OPENAI_API_KEY` | ✅ | code `.optional()`; spec required. Tighten + add `.startsWith('sk-')`. |
| `OPENAI_EMBEDDING_MODEL` | `OPENAI_EMBEDDING_MODEL` (RAG only) | ⚠️ | Only RAG declares it; main app should also see for parity. |
| `OPENAI_EMBEDDING_DIMENSIONS` | `OPENAI_EMBEDDING_DIMENSIONS` (RAG only) | ⚠️ | Same. Add `.refine(v => v === 1536)`. |

## §28.7 — Stripe — **PRICE-ID NAMING DRIFT**

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | `STRIPE_SECRET_KEY` | ✅ | tighten to `.regex(/^sk_(test|live)_/)`. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | ✅ | |
| `STRIPE_WEBHOOK_SECRET` | `STRIPE_WEBHOOK_SECRET` | ✅ | tighten to `.startsWith('whsec_')`. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `STRIPE_CONNECT_WEBHOOK_SECRET` | ✅ | tighten. |
| `STRIPE_CONNECT_CLIENT_ID` | `STRIPE_CONNECT_CLIENT_ID` | ⚠️ | code `.optional()`; spec required. |
| `STRIPE_PLATFORM_ACCOUNT_ID` | — | 🆕 | Spec required. |
| `STRIPE_PRICE_BYO_RESEARCH_*` | `STRIPE_PRICE_BYO_RESEARCH_*` | ✅ | |
| `STRIPE_PRICE_BYO_PRO_*` | `STRIPE_PRICE_BYO_PROFESSIONAL_*` | ⚠️ | "PRO" (spec) vs "PROFESSIONAL" (code). |
| `STRIPE_PRICE_BYO_AGENCY_*` | `STRIPE_PRICE_BYO_AGENCY_*` | ✅ | |
| `STRIPE_PRICE_BYO_AGENCY_SEAT_*` | `STRIPE_PRICE_BYO_AGENCY_SEATS_*` | ⚠️ | singular (spec) vs plural (code). |
| `STRIPE_PRICE_SUBHOST_*` | `STRIPE_PRICE_SUBHOST_*` (same naming drift PRO vs SEAT(S)) | ⚠️ | Same. |
| Spec: all price IDs **required** | Code: all `.optional()` | ⚠️ | Code-side rationale: missing price ID should fail at call time with a clearer error, not at boot. Reconfirm with operator. |

## §28.8 — Resend

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | `RESEND_API_KEY` | ⚠️ | code `.optional()`; spec required. Tighten + add `.startsWith('re_')`. |
| `RESEND_WEBHOOK_SECRET` | `RESEND_WEBHOOK_SECRET` | ⚠️ | code `.optional()`; spec required. |
| `RESEND_FROM_DOMAIN` | — | 🆕 | Spec required. |
| `RESEND_FROM_ADDRESS_DEFAULT` | — | 🆕 | Spec required. |
| `RESEND_FROM_NAME_DEFAULT` | — | 🆕 | Spec required. |

## §28.9 — OAuth Providers

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `OAUTH_GOOGLE_ENABLED` | — | 🆕 | Default true. |
| `OAUTH_MICROSOFT_ENABLED` | — | 🆕 | Default true. Conditional requirement gates `MICROSOFT_GRAPH_*` vars. |
| `OAUTH_FACEBOOK_ENABLED` | — | 🆕 | Default true. |
| `OAUTH_APPLE_ENABLED` | — | 🆕 | Default false (deferred). |
| `MICROSOFT_GRAPH_CLIENT_ID` | — | 🆕 | If MS enabled. |
| `MICROSOFT_GRAPH_CLIENT_SECRET` | — | 🆕 | If MS enabled. |
| `MICROSOFT_GRAPH_CLIENT_SECRET_PREVIOUS` | — | 🆕 | Optional, rotation overlap. |
| — | `MICROSOFT_GRAPH_TENANT_ID` | 📦 | Code addition (§17.2 no-email fallback) — default `"common"`. |

## §28.10 — Gmail Integration

All Gmail vars are 🆕 (per-tenant Gmail integration not yet wired): `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_CLIENT_SECRET_PREVIOUS`, `GMAIL_PUBSUB_VERIFICATION_TOKEN`, `GMAIL_PUBSUB_TOPIC`. Treat as optional at boot; runtime check in handler.

## §28.11 — Inngest

| Spec name | Code name | Status |
|---|---|---|
| `INNGEST_EVENT_KEY` | `INNGEST_EVENT_KEY` | ✅ |
| `INNGEST_SIGNING_KEY` | `INNGEST_SIGNING_KEY` | ✅ |
| `INNGEST_SERVE_PATH` | — | 🆕 default-ok, optional |

## §28.12 — Image Generation — **PROVIDER NAMING DRIFT**

| Spec | Code | Status | Notes |
|---|---|---|---|
| `IMAGE_GEN_PROVIDER` ('replicate' or 'openai_dalle3') | `IMAGE_GEN_PROVIDER` ('openai' or 'none') | ⚠️ | Different enum values. Replicate not wired. |
| `REPLICATE_API_TOKEN` | — | 🆕 if Replicate. Not wired. |
| `REPLICATE_SDXL_MODEL_VERSION` | — | 🆕 if Replicate. Not wired. |
| `OPENAI_DALLE_API_KEY` | — (reuses `OPENAI_API_KEY`) | ⚠️ | Spec wants separate key; code shares with embeddings. |
| `IMAGE_GEN_DAILY_LIMIT_PER_TENANT` | `IMAGE_GEN_RATE_LIMIT_DAILY` | ⚠️ | Same concept, different name. |

## §28.13 — Encryption — **PRIOR vs PREVIOUS NAMING DRIFT**

| Spec name | Code name | Status | Notes |
|---|---|---|---|
| `APP_ENCRYPTION_KEY_CURRENT` | `APP_ENCRYPTION_KEY_CURRENT` | ✅ | Boot-time 32-byte check already exists. |
| `APP_ENCRYPTION_KEY_PREVIOUS` | `APP_ENCRYPTION_KEY_PREVIOUS` | ✅ | Singular `_PREVIOUS` matches spec. |
| `APP_ENCRYPTION_KEY_ID_CURRENT` | `APP_ENCRYPTION_KEY_ID_CURRENT` | ✅ | |
| `APP_ENCRYPTION_KEY_ID_PREVIOUS` | `APP_ENCRYPTION_KEY_ID_PREVIOUS` | ✅ | |
| `APP_ENCRYPTION_BACKUP_VERIFIED_AT` | — | 🆕 | Spec required (operator-set ISO timestamp). Warn-only when > 100 days old (boot-time → Sentry). Add. |
| `FORENSICS_ENCRYPTION_KEY_CURRENT` | `FORENSICS_ENCRYPTION_KEY_CURRENT` | ✅ | Boot-time separation check exists. |
| — | `FORENSICS_ENCRYPTION_KEY_PRIOR_1` / `_PRIOR_2` | 📦 | Code uses `_PRIOR_1`/`_PRIOR_2` (two-step grace). Spec mentions only `_PREVIOUS`. **Naming drift forensics: PRIOR_N vs PREVIOUS.** |
| — | `FORENSICS_ENCRYPTION_KEY_ID_CURRENT`, `_ID_PRIOR_1`, `_ID_PRIOR_2` | 📦 | Same drift. |

## §28.14 — Audit & Observability

| Spec | Code | Status |
|---|---|---|
| `SENTRY_DSN` | — | 🆕 BP26 deferred operator provisioning |
| `SENTRY_ENVIRONMENT` | — | 🆕 |
| `LOG_LEVEL` | — | 🆕 |
| `AUDIT_LOG_RETENTION_YEARS` | — | 🆕 default 7 |
| — | `OPERATOR_SLACK_WEBHOOK_URL` | 🚧 📦 | BP26 code reads `process.env` directly. Not in schema. |

## §28.15 — Feature Flags / Toggles

| Spec | Code | Status |
|---|---|---|
| `AI_GLOBAL_KILL_SWITCH` | — | 🆕 §10.6 — code path exists but reads from `platform_settings` table, not env. Operator preference: env-var kill switch is faster than DB update. |
| `RAG_INGESTION_PAUSED` | — | 🆕 |
| `MAINTENANCE_MODE` | — | 🆕 |
| `SIGNUP_ENABLED` | — | 🆕 default true |
| `STRIPE_CONNECT_ONBOARDING_ENABLED` | — | 🆕 default true |

Code-only flags: `STAGING_MODE`, `TEST_OVERRIDE_EMAIL`, `TEST_OVERRIDE_PHONE` (BP25).

## §28.16 — Tone & Persona

| Spec | Code | Status |
|---|---|---|
| `PERSONA_TONE_DEFAULT_MAX_LEVEL` | — | 🆕 default 3 |
| `PERSONA_ADDENDUM_HAIKU_SCREEN_ENABLED` | — | 🆕 default true |
| `SUPERVISOR_REGEN_MAX_PER_CONVERSATION` | `SUPERVISOR_REGEN_MAX_PER_CONVERSATION` | ✅ |
| `SUPERVISOR_REGEN_MAX_TOKENS_PER_CONVERSATION` | `SUPERVISOR_REGEN_MAX_TOKENS_PER_CONVERSATION` | ✅ |
| `MEMORY_EXTRACTION_DEBOUNCE_SECONDS` | `MEMORY_EXTRACTION_DEBOUNCE_SECONDS` | ✅ |
| `MEMORY_EXTRACTION_MESSAGE_WINDOW` | `MEMORY_EXTRACTION_MESSAGE_WINDOW` | ✅ |

## §28.17 — Abuse Monitoring

| Spec | Code | Status |
|---|---|---|
| `ABUSE_AI_COST_RECOMPUTE_INTERVAL_SECONDS` | `ABUSE_RECOMPUTE_CRON_SCHEDULE` | ⚠️ | Different surface (cron vs seconds). |
| `ABUSE_OVERRIDE_REQUIRE_REAUTH` | — | 🆕 default true |
| `ABUSE_RAG_PROMOTION_BONUS_PER_CHUNK` | — | 🆕 default 25 (hardcoded in code today) |

## Code-only (legit feature-specific, not spec-listed at top level)

- `PLATFORM_PEPPER` (§25 — D-058 — NEVER ROTATE)
- `INVITATION_TOKEN_HMAC_KEY`, `COMPANION_TOKEN_HMAC_KEY` (§18.2 / §23.5)
- `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`, `PLATFORM_PARENT_DOMAIN`, `DNS_RESOLVER_URL`, `RESERVED_PARENT_DOMAIN` (§16 white-label)
- `HOST_ADAPTER_FALLBACK_EMAIL_TO`, `_FROM` (§13.6)
- `MAIN_APP_URL`, `MAIN_APP_ADMIN_API_KEY` (RAG service — §8.3 reconcile callback)
- `FORUM_MODERATION_HAIKU_TIMEOUT_MS`, `FORUM_MODERATION_RETRY_TIMEOUT_HOURS`, `HAIKU_FORUM_MODERATION_MODEL` (§19.3)
- `RAG_CHUNK_*`, `RAG_INGEST_*`, `GCV_API_KEY` (§21 / §22)
- `QUOTE_PDF_RENDERER`, `QUOTE_ESTIMATE_VALIDITY_DAYS`, `QUOTE_DEFAULT_VARIANCE_CENTS` (§21.10.1)
- `PRECRUISE_T*_HOURS_BEFORE` (§23.4)
- `ANON_CHAT_LIMIT_*`, `CUSTOMER_CHAT_*` (§24.8 / §24.9)
- `CHAT_HAIKU_MODEL`, `ENTITY_EXTRACTION_MODEL`, `PERSONA_ADDENDUM_HAIKU_MODEL`, `RAG_INGEST_*_HAIKU_MODEL` (per-feature model pins)
- `ANTHROPIC_DAILY_PRICING_CACHE_TTL_HOURS`, `OPENAI_DAILY_PRICING_CACHE_TTL_HOURS` (§27.12)
- `ABUSE_AI_COST_SOFT1/2/HARD_PERCENT`, `ABUSE_RAG_APPROACHING_PERCENT`, `ABUSE_EMAIL_BOUNCE_RATE_THRESHOLD_PERCENT` (§27.4)
- `ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS`, `ABUSE_TENANT_USAGE_REFRESH_SECONDS` (BP28)

## process.env bypasses (not in env.ts schema)

- `NEXT_PUBLIC_APP_URL` — referenced in BP28 (`abuse-state-transition-notify.ts`, `usage` route). **Add to schema.**
- `OPERATOR_SLACK_WEBHOOK_URL` — referenced in BP26 (`lib/monitoring/send-operator-alert.ts`). **Add to schema.**
- `FORENSICS_ENCRYPTION_KEY_ID_PRIOR_1`, `_PRIOR_2` — referenced in BP25/26 forensics decrypt; **add to schema as optional.**

---

## Summary — what BP29 should reconcile

**Low-risk: add + tighten in env.ts**
1. Add: `NEXT_PUBLIC_APP_URL`, `OPERATOR_SLACK_WEBHOOK_URL`, `FORENSICS_ENCRYPTION_KEY_ID_PRIOR_1`, `_PRIOR_2`.
2. Add (optional with sane defaults): all spec-listed vars not yet present (`ANTHROPIC_SONNET_MODEL`, `ANTHROPIC_HAIKU_MODEL`, `ANTHROPIC_PROMPT_CACHE_ENABLED`, `RESEND_FROM_*`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `LOG_LEVEL`, `AUDIT_LOG_RETENTION_YEARS`, `OAUTH_*_ENABLED`, `AI_GLOBAL_KILL_SWITCH`, `RAG_INGESTION_PAUSED`, `MAINTENANCE_MODE`, `SIGNUP_ENABLED`, `STRIPE_CONNECT_ONBOARDING_ENABLED`, `PERSONA_TONE_DEFAULT_MAX_LEVEL`, `PERSONA_ADDENDUM_HAIKU_SCREEN_ENABLED`, `ABUSE_OVERRIDE_REQUIRE_REAUTH`, `ABUSE_RAG_PROMOTION_BONUS_PER_CHUNK`, `INTER_SERVICE_JWT_TTL_SECONDS`, `INNGEST_SERVE_PATH`).
3. Tighten constraints on existing vars: `ANTHROPIC_API_KEY.startsWith('sk-ant-')`, `OPENAI_API_KEY.startsWith('sk-')`, `STRIPE_SECRET_KEY.regex(/^sk_(test|live)_/)`, `STRIPE_WEBHOOK_SECRET.startsWith('whsec_')`, `RESEND_API_KEY.startsWith('re_')`, `OPENAI_EMBEDDING_DIMENSIONS.refine(v => v === 1536)`, etc.
4. Add `APP_ENCRYPTION_BACKUP_VERIFIED_AT` (Sentry-warn-only when > 100 days old).
5. Conditional `superRefine`: when `OAUTH_MICROSOFT_ENABLED=true`, require `MICROSOFT_GRAPH_CLIENT_ID` + `MICROSOFT_GRAPH_CLIENT_SECRET`.

**High-risk: spec naming drift (renaming touches CI + Vercel envs)**
A. `SERVICE_JWT_*` → `INTER_SERVICE_JWT_*` (4-var rename; touches RAG service + GitHub Actions workflow + Vercel envs).
B. `SUPABASE_RAG_*` → `RAG_SUPABASE_*` (3-var rename; RAG service + CI + Vercel).
C. `STRIPE_PRICE_BYO_PROFESSIONAL_*` → `STRIPE_PRICE_BYO_PRO_*` (2-var rename) and `_SEATS_` → `_SEAT_` (4-var rename).
D. `IMAGE_GEN_RATE_LIMIT_DAILY` → `IMAGE_GEN_DAILY_LIMIT_PER_TENANT`.
E. `ABUSE_RECOMPUTE_CRON_SCHEDULE` → `ABUSE_AI_COST_RECOMPUTE_INTERVAL_SECONDS` (semantic change: cron→seconds).
F. `FORENSICS_ENCRYPTION_KEY_PRIOR_1/2` (code) vs `_PREVIOUS` (spec) — keep `_PRIOR_N` (operator chose two-step grace; document spec waiver in MEMORY).

**Spec amendments to propose** (the spec is wrong / outdated in these places):
- §28.13 should list `FORENSICS_ENCRYPTION_KEY_PRIOR_1`, `_PRIOR_2` (two-step grace pattern actually used).
- §28.7 should clarify singular `_SEAT_` vs plural `_SEATS_` and `_PRO_` vs `_PROFESSIONAL_`.
- §28.3 should clarify `SUPABASE_RAG_*` vs `RAG_SUPABASE_*` convention (operator-chosen).
- §28.4 should clarify `SERVICE_JWT_*` vs `INTER_SERVICE_JWT_*` convention.

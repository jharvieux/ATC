// BP29 / §28 — canonical env-var schema for the main app.
//
// Naming-drift waivers vs spec §28 (operator-confirmed during BP29):
//   - `SERVICE_JWT_*` (code) keeps its name; spec lists `INTER_SERVICE_JWT_*`.
//   - `SUPABASE_RAG_*` (RAG service) keeps its prefix; spec lists `RAG_SUPABASE_*`.
//   - `STRIPE_PRICE_BYO_PROFESSIONAL_*` keeps `_PROFESSIONAL_`; spec lists `_PRO_`.
//   - `STRIPE_PRICE_*_SEATS_*` keeps the plural; spec lists `_SEAT_`.
//   - `IMAGE_GEN_RATE_LIMIT_DAILY` keeps its name; spec lists `IMAGE_GEN_DAILY_LIMIT_PER_TENANT`.
//   - All `STRIPE_PRICE_*` stay `.optional()` (call-site failure has clearer
//     diagnostics than boot failure); spec lists them as required-at-boot.
//   - `FORENSICS_ENCRYPTION_KEY_PRIOR_1`/`_2` two-step grace stays; spec lists `_PREVIOUS`.
// See docs/env-audit.md and MEMORY.md D-062 for the full reconciliation.

import { z } from "zod";
import { Buffer } from "node:buffer";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GIT_COMMIT_SHA: z.string().optional(),
  PLATFORM_PRIMARY_DOMAIN: z.string().min(1),
  // Regex matching subdomains of PLATFORM_PRIMARY_DOMAIN. Capture group 1
  // must be the slug. Example: ^([a-z0-9-]+)\.aitravelconcierge\.com$
  PLATFORM_DOMAIN_REGEX: z.string().min(1),
  // Public app URL — used by email links and the tenant /settings/usage page.
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  // §28.1 — operator-facing platform branding (spec required; treated as
  // optional pending operator population — falls back at the template layer).
  NEXT_PUBLIC_PLATFORM_BRAND_NAME: z.string().optional(),
  NEXT_PUBLIC_PLATFORM_SUPPORT_EMAIL: z.string().email().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Spec §28.2 — present at boot when Supabase Auth verifies JWTs directly
  // (the platform currently relies on Supabase's built-in verification, so
  // this is informational/optional today).
  SUPABASE_JWT_SECRET: z.string().optional(),
  // Migration role connection — used by CI workflow + operator tooling, not
  // by the running app. Optional at boot.
  SUPABASE_DB_URL: z.string().optional(),
  // Stripe — key names verified against Stripe docs (stable as of 2026)
  // §28.7 + §28.22: STRIPE_SECRET_KEY shape gates the test/live mode signal.
  STRIPE_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, "must start with sk_test_ or sk_live_"),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().regex(/^pk_(test|live)_/, "must start with pk_test_ or pk_live_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_", "must start with whsec_"),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().startsWith("whsec_", "must start with whsec_"),
  // Spec §28.7 — platform's own Stripe account ID (treated optional pending
  // operator provisioning; call sites that need it fail with a clearer error).
  STRIPE_PLATFORM_ACCOUNT_ID: z.string().optional(),
  // Inngest
  INNGEST_SIGNING_KEY: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().min(1),
  INNGEST_SERVE_PATH: z.string().optional().default("/api/inngest"),
  // Service-to-service JWT signing (§8.3 — spec §28.4 calls these
  // INTER_SERVICE_JWT_*; operator chose to keep the existing SERVICE_JWT_
  // prefix. See docs/env-audit.md and MEMORY D-062.)
  SERVICE_JWT_PRIVATE_KEY: z.string().min(1),
  SERVICE_JWT_KEY_ID: z.string().min(1),
  SERVICE_JWT_TTL_SECONDS: z.coerce.number().int().positive().optional().default(300),
  // RAG service sync (§8.7)
  RAG_SERVICE_URL: z.string().url(),
  RAG_WEBHOOK_SECRET: z.string().min(1),
  // Supervisor regen budget (§10.1a) — EITHER threshold trips exhaustion
  // Absolute regen-attempt cap per conversation (default 6)
  SUPERVISOR_REGEN_MAX_PER_CONVERSATION: z.coerce.number().int().positive().optional().default(6),
  // Cumulative token cap across all regen attempts per conversation (default 25000)
  SUPERVISOR_REGEN_MAX_TOKENS_PER_CONVERSATION: z.coerce.number().int().positive().optional().default(25000),
  // Memory extraction debounce (§11.2.3) — minimum gap in seconds between extraction runs per (tenant_id, user_id)
  MEMORY_EXTRACTION_DEBOUNCE_SECONDS: z.coerce.number().int().positive().optional().default(120),
  // Number of recent messages fed to Haiku for extraction (§11.2.5)
  MEMORY_EXTRACTION_MESSAGE_WINDOW: z.coerce.number().int().positive().optional().default(50),
  // Delay in ms before re-enqueue on optimistic-lock conflict (§11.2.4)
  MEMORY_EXTRACTION_RETRY_DELAY_MS: z.coerce.number().int().positive().optional().default(5000),
  // Credential encryption (§13.5.1) — 256-bit keys, base64-encoded
  APP_ENCRYPTION_KEY_CURRENT: z.string().min(1),
  APP_ENCRYPTION_KEY_ID_CURRENT: z.string().min(1),
  APP_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  APP_ENCRYPTION_KEY_ID_PREVIOUS: z.string().optional(),
  // §28.13 — ISO timestamp of last successful encryption-key backup verification
  // (§13.5.3). Operator-set after each quarterly sandbox restore test. The boot
  // check below emits a Sentry warning when this is > 100 days old.
  APP_ENCRYPTION_BACKUP_VERIFIED_AT: z.string().datetime({ offset: true }).optional(),
  // Stripe Connect (§14.7 / §15.9)
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  // Stripe Price IDs (§14.x / §15.8) — optional so missing IDs fail at call time, not boot
  STRIPE_PRICE_SUBHOST_STARTER_MONTHLY:  z.string().optional(),
  STRIPE_PRICE_SUBHOST_STARTER_ANNUAL:   z.string().optional(),
  STRIPE_PRICE_SUBHOST_PRO_MONTHLY:      z.string().optional(),
  STRIPE_PRICE_SUBHOST_PRO_ANNUAL:       z.string().optional(),
  STRIPE_PRICE_SUBHOST_AGENCY_MONTHLY:   z.string().optional(),
  STRIPE_PRICE_SUBHOST_AGENCY_ANNUAL:    z.string().optional(),
  STRIPE_PRICE_SUBHOST_AGENCY_SEATS_MONTHLY: z.string().optional(),
  STRIPE_PRICE_SUBHOST_AGENCY_SEATS_ANNUAL:  z.string().optional(),
  STRIPE_PRICE_BYO_RESEARCH_MONTHLY:     z.string().optional(),
  STRIPE_PRICE_BYO_RESEARCH_ANNUAL:      z.string().optional(),
  STRIPE_PRICE_BYO_PROFESSIONAL_MONTHLY: z.string().optional(),
  STRIPE_PRICE_BYO_PROFESSIONAL_ANNUAL:  z.string().optional(),
  STRIPE_PRICE_BYO_AGENCY_MONTHLY:       z.string().optional(),
  STRIPE_PRICE_BYO_AGENCY_ANNUAL:        z.string().optional(),
  STRIPE_PRICE_BYO_AGENCY_SEATS_MONTHLY: z.string().optional(),
  STRIPE_PRICE_BYO_AGENCY_SEATS_ANNUAL:  z.string().optional(),
  // Fallback email adapter (§13.6)
  HOST_ADAPTER_FALLBACK_EMAIL_TO: z.string().email().optional(),
  HOST_ADAPTER_FALLBACK_EMAIL_FROM: z.string().email().optional(),
  // §28.8 — Resend keys + Pattern-B default sender. RESEND_API_KEY shape
  // validated when present; spec lists required but call sites tolerate
  // absence (Pattern-A tenants supply per-tenant keys).
  RESEND_API_KEY: z.string().startsWith("re_", "must start with re_").optional(),
  RESEND_FROM_DOMAIN: z.string().optional(),
  RESEND_FROM_ADDRESS_DEFAULT: z.string().email().optional(),
  RESEND_FROM_NAME_DEFAULT: z.string().optional(),
  // White-label (§16) — BP18
  VERCEL_API_TOKEN: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  PLATFORM_PARENT_DOMAIN: z.string().optional(),
  PLATFORM_ENV: z.enum(["production", "staging", "preview", "development"]).optional().default("development"),
  DNS_RESOLVER_URL: z.string().url().optional().default("https://cloudflare-dns.com/dns-query"),
  PERSONA_ADDENDUM_HAIKU_MODEL: z.string().optional().default("claude-haiku-4-5-20251001"),
  // The canonical reserved parent domain (§16.3.4). Crown-jewel guard refuses
  // to bind this in non-production environments.
  RESERVED_PARENT_DOMAIN: z.string().optional().default("tenants.ai-travelconcierge.com"),
  // Group bookings — §18.5 / §18.2
  // 256-bit key, base64-encoded. Required. Generate: openssl rand -base64 32
  INVITATION_TOKEN_HMAC_KEY: z.string().min(1),
  // Microsoft Graph tenant ID for no-email fallback (§17.2). Default 'common'
  // handles personal + work accounts; override with your tenant GUID to restrict.
  MICROSOFT_GRAPH_TENANT_ID: z.string().optional().default("common"),
  // Image generation for group hero images (§18.3). Provider: 'openai' | 'none'.
  IMAGE_GEN_PROVIDER: z.enum(["openai", "none"]).optional().default("openai"),
  // §28.6 — OpenAI API key. Spec lists required; code keeps optional because
  // image-generation can be disabled (IMAGE_GEN_PROVIDER='none'). Shape
  // validated when present.
  OPENAI_API_KEY: z.string().startsWith("sk-", "must start with sk-").optional(),
  // Per-tenant daily AI image generation cap (§18.3).
  IMAGE_GEN_RATE_LIMIT_DAILY: z.coerce.number().int().positive().optional().default(20),
  // Forum moderation — §19.3 fail-closed Haiku contract
  HAIKU_FORUM_MODERATION_MODEL: z.string().optional().default("claude-haiku-4-5-20251001"),
  // Timeout in ms for the synchronous Haiku moderation call (§19.3).
  FORUM_MODERATION_HAIKU_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(2000),
  // Hours before a stuck pending_moderation message auto-escalates to flagged_review (§19.3).
  FORUM_MODERATION_RETRY_TIMEOUT_HOURS: z.coerce.number().int().positive().optional().default(24),
  // RAG consumer & hallucination defense — §21
  // Haiku model used for entity extraction from chat messages (§21.2).
  ENTITY_EXTRACTION_MODEL: z.string().optional().default("claude-haiku-4-5-20251001"),
  // Drop any retrieved chunk below this composite confidence (§21.3).
  RAG_CHUNK_CONFIDENCE_FLOOR: z.coerce.number().min(0).max(1).optional().default(0.35),
  // Cosine similarity above which two chunks are considered duplicates for dedup (§21.3).
  RAG_CHUNK_DEDUP_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.8),
  // Final cap on number of chunks injected into the knowledge block (§21.3).
  RAG_CHUNK_TOP_N_DEFAULT: z.coerce.number().int().min(3).max(5).optional().default(4),
  // Quote PDF rendering library (§21.10.1). Operator choice — see MEMORY for rationale.
  QUOTE_PDF_RENDERER: z.enum(["puppeteer", "react-pdf"]).optional().default("react-pdf"),
  // Days an ESTIMATE quote remains valid before auto-expiry (§21.10.1).
  QUOTE_ESTIMATE_VALIDITY_DAYS: z.coerce.number().int().positive().optional().default(7),
  // Default per-tenant variance threshold in cents (§21.10.1) — operator can override per-tenant.
  QUOTE_DEFAULT_VARIANCE_CENTS: z.coerce.number().int().nonnegative().optional().default(5000),
  // §28.5 — Anthropic API key. Spec required + sk-ant- shape. Tightened per
  // BP29 (operator confirmation). CI placeholder must use the sk-ant- prefix.
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-", "must start with sk-ant-"),
  // §28.5 model strings — feature-specific HAIKU model envs (CHAT_HAIKU_MODEL etc.)
  // override; these are the platform defaults.
  ANTHROPIC_SONNET_MODEL: z.string().optional().default("claude-sonnet-4-6"),
  ANTHROPIC_HAIKU_MODEL: z.string().optional().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_PROMPT_CACHE_ENABLED: z.coerce.boolean().optional().default(true),
  // RAG ingestion — §22
  RAG_INGEST_PII_REDACTION_HAIKU_MODEL: z.string().optional().default("claude-haiku-4-5-20251001"),
  RAG_INGEST_NORMALIZATION_HAIKU_MODEL: z.string().optional().default("claude-haiku-4-5-20251001"),
  // Threshold above which a normalized chunk auto-flags for global-review consideration (§22.6).
  RAG_INGEST_GLOBAL_RELEVANCE_AUTOFLAG_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.6),
  // Aggregation window for PII quarantine alerts (§22.4a).
  RAG_INGEST_AGGREGATION_WINDOW_HOURS: z.coerce.number().int().positive().optional().default(24),
  // Consecutive-day count that trips the 'recurring pattern' abuse signal (§22.4a).
  RAG_INGEST_RECURRING_PATTERN_DAYS: z.coerce.number().int().positive().optional().default(3),
  // Max file upload size in bytes (§22.3). Default 50MB.
  RAG_INGEST_MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().optional().default(52428800),
  // OCR provider for scanned PDFs and image submissions (§22.3). Operator choice.
  // 'none' = OCR disabled; binary/image files without text layer fail at extraction.
  RAG_INGEST_OCR_PROVIDER: z.enum(["tesseract", "gcv", "none"]).optional().default("none"),
  // Google Cloud Vision API key — only required if RAG_INGEST_OCR_PROVIDER='gcv'.
  GCV_API_KEY: z.string().optional(),
  // Email & Notifications — §23
  // Resend webhook signing secret (required — verifies bounce/complaint events from Resend).
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  // Pre-cruise email timing — hours before sailing for each phase (§23.4).
  PRECRUISE_T90_HOURS_BEFORE: z.coerce.number().int().positive().optional().default(2160),
  PRECRUISE_T30_HOURS_BEFORE: z.coerce.number().int().positive().optional().default(720),
  PRECRUISE_T7_HOURS_BEFORE:  z.coerce.number().int().positive().optional().default(168),
  PRECRUISE_T1_HOURS_BEFORE:  z.coerce.number().int().positive().optional().default(24),
  // Companion page token HMAC key (§23.5).
  // Uses INVITATION_TOKEN_HMAC_KEY as fallback — see MEMORY D-056 for rationale.
  COMPANION_TOKEN_HMAC_KEY: z.string().optional(),
  // Chat UI — §24
  // Anonymous chat — §24.8 three-identifier limit (normal + under-abuse caps).
  ANON_CHAT_LIMIT_PER_SESSION:                z.coerce.number().int().positive().optional().default(5),
  ANON_CHAT_LIMIT_PER_IP_24H:                 z.coerce.number().int().positive().optional().default(15),
  ANON_CHAT_LIMIT_PER_FINGERPRINT_24H:        z.coerce.number().int().positive().optional().default(10),
  ANON_CHAT_LIMIT_PER_SESSION_UNDER_ABUSE:    z.coerce.number().int().positive().optional().default(2),
  ANON_CHAT_LIMIT_PER_IP_UNDER_ABUSE:         z.coerce.number().int().positive().optional().default(5),
  ANON_CHAT_LIMIT_PER_FINGERPRINT_UNDER_ABUSE: z.coerce.number().int().positive().optional().default(3),
  // Authenticated customer chat — §24.9 three-tier limit.
  CUSTOMER_CHAT_SOFT1_CAP:           z.coerce.number().int().positive().optional().default(20),
  CUSTOMER_CHAT_SOFT2_CAP:           z.coerce.number().int().positive().optional().default(30),
  CUSTOMER_CHAT_HARD_CAP:            z.coerce.number().int().positive().optional().default(40),
  CUSTOMER_CHAT_BOOKING_BONUS_PERCENT: z.coerce.number().int().nonnegative().optional().default(100),
  CUSTOMER_CHAT_LIMIT_HARD_CEILING:  z.coerce.number().int().positive().optional().default(200),
  CUSTOMER_CHAT_LIMIT_HARD_FLOOR:    z.coerce.number().int().positive().optional().default(15),
  CUSTOMER_CHAT_WINDOW_DAYS:         z.coerce.number().int().positive().optional().default(30),
  CUSTOMER_CHAT_SOFT1_COOLDOWN_DAYS: z.coerce.number().int().positive().optional().default(7),
  CUSTOMER_CHAT_SOFT2_COOLDOWN_DAYS: z.coerce.number().int().positive().optional().default(3),
  // §24.5 / §24.9 Haiku model for hard-limit conversation summary + heuristic tone-drift check.
  CHAT_HAIKU_MODEL: z.string().optional().default("claude-haiku-4-5-20251001"),
  // Retention / forensics — §25
  // PLATFORM_PEPPER: 256-bit secret used to derive customer hashes.
  // SET ONCE AT PLATFORM GENESIS. NEVER ROTATE — rotation breaks every
  // existing customer hash on bookings, commissions, and contacts.
  PLATFORM_PEPPER: z.string().min(1),
  // Forensics encryption keys — §26.5a. MUST be distinct from APP_ENCRYPTION_KEY_*.
  // Boot-time check below enforces the separation.
  FORENSICS_ENCRYPTION_KEY_CURRENT: z.string().min(1),
  FORENSICS_ENCRYPTION_KEY_ID_CURRENT: z.string().optional().default("forensics-v1"),
  FORENSICS_ENCRYPTION_KEY_PRIOR_1: z.string().optional(),
  FORENSICS_ENCRYPTION_KEY_PRIOR_2: z.string().optional(),
  // §25.10 staging real-PII risk acceptance — outbound isolation envs.
  STAGING_MODE: z.enum(["true", "false"]).optional().default("false"),
  TEST_OVERRIDE_EMAIL: z.string().email().optional(),
  TEST_OVERRIDE_PHONE: z.string().optional(),
  // SaaS abuse monitoring + cost controls — §27
  ANTHROPIC_DAILY_PRICING_CACHE_TTL_HOURS: z.coerce.number().int().positive().optional().default(24),
  OPENAI_DAILY_PRICING_CACHE_TTL_HOURS:    z.coerce.number().int().positive().optional().default(24),
  ABUSE_AI_COST_SOFT1_PERCENT:             z.coerce.number().int().positive().optional().default(30),
  ABUSE_AI_COST_SOFT2_PERCENT:             z.coerce.number().int().positive().optional().default(50),
  ABUSE_AI_COST_HARD_PERCENT:              z.coerce.number().int().positive().optional().default(70),
  ABUSE_RAG_APPROACHING_PERCENT:           z.coerce.number().int().positive().optional().default(85),
  ABUSE_EMAIL_BOUNCE_RATE_THRESHOLD_PERCENT: z.coerce.number().int().positive().optional().default(5),
  // BP28 — abuse dashboard + recompute
  ABUSE_RECOMPUTE_CRON_SCHEDULE:        z.string().optional().default("0 3 * * *"),
  ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS: z.coerce.number().int().positive().optional().default(30),
  ABUSE_TENANT_USAGE_REFRESH_SECONDS:   z.coerce.number().int().positive().optional().default(60),
  // BP31 §32.14 — GitHub App for Self-Service Help issue creation. All
  // required because the feature is server-side gated on these and a
  // missing config means bug/feature submissions fail silently at runtime.
  GITHUB_APP_ID:               z.string().min(1),
  GITHUB_APP_PRIVATE_KEY:      z.string().includes("-----BEGIN", { message: "must be a PEM-format private key" }),
  GITHUB_APP_INSTALLATION_ID:  z.string().min(1),
  GITHUB_REPO_OWNER:           z.string().min(1),
  GITHUB_REPO_NAME:            z.string().min(1),
  // PDF / Word cache TTL for the help docs export. Default 1 hour per §32.3.3.
  HELP_DOCS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().optional().default(3600),
  // BP32 §32.14 — Phase 2 customer bug flow toggles. Ship dark by default;
  // operator flips to true per the §32.15 Phase 2 alignment.
  PHASE_2_CUSTOMER_BUG_FLOW_ENABLED: z.coerce.boolean().optional().default(false),
  CUSTOMER_BUG_PER_DAY_LIMIT:        z.coerce.number().int().positive().optional().default(5),
  // BP32 §32.10.7 — GitHub webhook secret used to verify issues.closed events.
  // Optional because Phase 2 ships dark; the webhook route 401s without it.
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  // BP34 §33.10 — Apify integration. Default-OFF cost-deferral: the adapter
  // kill switch defaults to false; operator flips ENABLED to true AND provides
  // the API token to activate spend. With this default, just provisioning
  // APIFY_API_TOKEN does NOT immediately trigger spend.
  APIFY_API_TOKEN:                     z.string().optional(),
  APIFY_ADAPTER_ENABLED:               z.coerce.boolean().optional().default(false),
  APIFY_RUN_BUDGET_USD_CEILING:        z.coerce.number().positive().optional().default(50),
  APIFY_MONTHLY_BUDGET_USD_CEILING:    z.coerce.number().positive().optional().default(500),
  PRICE_FRESHNESS_FRESH_HOURS:         z.coerce.number().int().positive().optional().default(72),
  PRICE_FRESHNESS_EXPIRED_HOURS:       z.coerce.number().int().positive().optional().default(744), // 31 days
  // BP35 §33.4 — CruiseMapper itinerary monthly Inngest ingest. Default-OFF
  // cost-deferral (real OpenAI embedding cost when on). Requires the BP34
  // Apify guard fence (APIFY_ADAPTER_ENABLED + APIFY_API_TOKEN) before any
  // actor dispatch — this flag is the *additional* opt-in for the
  // CruiseMapper itinerary path specifically.
  CRUISEMAPPER_ITINERARY_INGEST_ENABLED: z.coerce.boolean().optional().default(false),
  CRUISEMAPPER_ITINERARY_ACTOR_ID:       z.string().optional().default("crawlerbros/cruisemapper-cruises-scraper"),
  // BP36 §33.5 — CruiseMapper DIY (text-only) scraper. Default-OFF cost-deferral.
  // The User-Agent header MUST identify the platform with a real ops contact
  // email so CruiseMapper can reach us before blocking. Optional at boot — the
  // scraper job logs and no-ops if it isn't set.
  CRUISEMAPPER_DIY_USER_AGENT:           z.string().optional(),
  CRUISEMAPPER_DIY_INGEST_ENABLED:       z.coerce.boolean().optional().default(false),
  CRUISEMAPPER_DIY_RATE_LIMIT_RPS:       z.coerce.number().positive().optional().default(1.0),
  CRUISEMAPPER_DIY_BASE_URL:             z.string().url().optional().default("https://www.cruisemapper.com"),
  // BP40 §33.8 — price-watch subscriptions. Default-OFF cost-deferral:
  // when false, the daily Inngest job STILL runs and updates statuses
  // (active → triggered) so the UI reflects reality, but no notification
  // is sent. Operator flips to true to actually email/in-app-notify
  // subscribers.
  PRICE_WATCH_NOTIFICATIONS_ENABLED:     z.coerce.boolean().optional().default(false),
  // §28.17 — abuse-control toggles (spec-listed; code currently uses hardcoded
  // defaults at the call sites).
  ABUSE_OVERRIDE_REQUIRE_REAUTH:        z.coerce.boolean().optional().default(true),
  ABUSE_RAG_PROMOTION_BONUS_PER_CHUNK:  z.coerce.number().int().positive().optional().default(25),
  // §28.9 — OAuth provider toggles. Conditional MS-Graph requirement
  // enforced via superRefine below.
  OAUTH_GOOGLE_ENABLED:    z.coerce.boolean().optional().default(true),
  OAUTH_MICROSOFT_ENABLED: z.coerce.boolean().optional().default(true),
  OAUTH_FACEBOOK_ENABLED:  z.coerce.boolean().optional().default(true),
  OAUTH_APPLE_ENABLED:     z.coerce.boolean().optional().default(false),
  MICROSOFT_GRAPH_CLIENT_ID:                z.string().optional(),
  MICROSOFT_GRAPH_CLIENT_SECRET:            z.string().optional(),
  MICROSOFT_GRAPH_CLIENT_SECRET_PREVIOUS:   z.string().optional(),
  // §28.10 — Gmail per-tenant integration (deferred; treat as optional at boot).
  GMAIL_OAUTH_CLIENT_ID:               z.string().optional(),
  GMAIL_OAUTH_CLIENT_SECRET:           z.string().optional(),
  GMAIL_OAUTH_CLIENT_SECRET_PREVIOUS:  z.string().optional(),
  GMAIL_PUBSUB_VERIFICATION_TOKEN:     z.string().optional(),
  GMAIL_PUBSUB_TOPIC:                  z.string().optional(),
  // §28.14 — audit & observability. Sentry DSN optional pending operator
  // provisioning; lint will not fail without it.
  SENTRY_DSN:               z.string().optional(),
  SENTRY_ENVIRONMENT:       z.string().optional(),
  LOG_LEVEL:                z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  AUDIT_LOG_RETENTION_YEARS: z.coerce.number().int().positive().optional().default(7),
  // Operator alert routing — Slack webhook for elevated-severity monitoring
  // alerts. BP26 reads this directly via process.env; declared here so the
  // schema-walking parity test stays green.
  OPERATOR_SLACK_WEBHOOK_URL: z.string().url().optional(),
  // §28.15 — operational toggles. Env-based so they can flip without a DB
  // round-trip; spec rationale at §28.15.
  AI_GLOBAL_KILL_SWITCH:                z.coerce.boolean().optional().default(false),
  RAG_INGESTION_PAUSED:                 z.coerce.boolean().optional().default(false),
  MAINTENANCE_MODE:                     z.coerce.boolean().optional().default(false),
  SIGNUP_ENABLED:                       z.coerce.boolean().optional().default(true),
  STRIPE_CONNECT_ONBOARDING_ENABLED:    z.coerce.boolean().optional().default(true),
  // §28.16 — tone & persona defaults.
  PERSONA_TONE_DEFAULT_MAX_LEVEL:       z.coerce.number().int().min(1).max(5).optional().default(3),
  PERSONA_ADDENDUM_HAIKU_SCREEN_ENABLED: z.coerce.boolean().optional().default(true),
})
  // §28.9 conditional: MS Graph creds required when Microsoft OAuth is on.
  .superRefine((data, ctx) => {
    if (data.OAUTH_MICROSOFT_ENABLED) {
      if (!data.MICROSOFT_GRAPH_CLIENT_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MICROSOFT_GRAPH_CLIENT_ID"],
          message: "Required when OAUTH_MICROSOFT_ENABLED=true",
        });
      }
      if (!data.MICROSOFT_GRAPH_CLIENT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MICROSOFT_GRAPH_CLIENT_SECRET"],
          message: "Required when OAUTH_MICROSOFT_ENABLED=true",
        });
      }
    }
  });

type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

/**
 * §28.19 boot-time env validation. Surfaces every failure at once so an
 * operator can fix all misconfigurations in a single pass instead of
 * playing whack-a-mole one error at a time.
 *
 * On failure: throws a single `Error` whose message lists every missing or
 * invalid variable. Caller (instrumentation.ts) lets the throw bubble up;
 * Next.js's instrumentation hook crashes the process before any request is
 * served. Key material is never included in the error message.
 */
export function verifyEnvAtBoot(): Env {
  if (_env) return _env;
  const errors: string[] = [];

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    throw new Error(`Missing or invalid environment variables:\n${errors.join("\n")}`);
  }
  const data = result.data;

  // §13.5.3 boot-time encryption key validation — accumulate then throw.
  const currentKeyBytes = Buffer.from(data.APP_ENCRYPTION_KEY_CURRENT, "base64");
  if (currentKeyBytes.length !== 32) {
    errors.push(
      `  APP_ENCRYPTION_KEY_CURRENT: must decode to exactly 32 bytes ` +
        `(got ${currentKeyBytes.length}). Key material is not logged.`,
    );
  }
  if (!data.APP_ENCRYPTION_KEY_ID_CURRENT) {
    errors.push("  APP_ENCRYPTION_KEY_ID_CURRENT: must be non-empty.");
  }
  if (data.APP_ENCRYPTION_KEY_PREVIOUS !== undefined) {
    const prevKeyBytes = Buffer.from(data.APP_ENCRYPTION_KEY_PREVIOUS, "base64");
    if (prevKeyBytes.length !== 32) {
      errors.push(
        `  APP_ENCRYPTION_KEY_PREVIOUS: must decode to exactly 32 bytes ` +
          `(got ${prevKeyBytes.length}). Key material is not logged.`,
      );
    }
    if (!data.APP_ENCRYPTION_KEY_ID_PREVIOUS) {
      errors.push(
        "  APP_ENCRYPTION_KEY_ID_PREVIOUS: must be non-empty when APP_ENCRYPTION_KEY_PREVIOUS is set.",
      );
    }
  }

  // §26.5a forensics-key separation. Compare as raw strings before decoding.
  if (data.FORENSICS_ENCRYPTION_KEY_CURRENT === data.APP_ENCRYPTION_KEY_CURRENT) {
    errors.push(
      "  FORENSICS_ENCRYPTION_KEY_CURRENT: [security-violation] must differ from " +
        "APP_ENCRYPTION_KEY_CURRENT per §26.5a. Generate a separate 256-bit base64 key. " +
        "Key material is not logged.",
    );
  }
  const forensicsKeyBytes = Buffer.from(data.FORENSICS_ENCRYPTION_KEY_CURRENT, "base64");
  if (forensicsKeyBytes.length !== 32) {
    errors.push(
      `  FORENSICS_ENCRYPTION_KEY_CURRENT: must decode to exactly 32 bytes ` +
        `(got ${forensicsKeyBytes.length}). Key material is not logged.`,
    );
  }

  // §16.3.4 reserved-parent-domain boot guard.
  if (
    data.PLATFORM_PARENT_DOMAIN &&
    data.PLATFORM_PARENT_DOMAIN === data.RESERVED_PARENT_DOMAIN &&
    data.PLATFORM_ENV !== "production"
  ) {
    errors.push(
      `  PLATFORM_PARENT_DOMAIN: [crown-jewel-guard] is set to the reserved value ` +
        `'${data.RESERVED_PARENT_DOMAIN}' but PLATFORM_ENV='${data.PLATFORM_ENV}' is not 'production'. ` +
        `The reserved parent domain MUST only be bound in the production Vercel project (§16.3.4).`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.join("\n")}`);
  }

  // §13.5.3 / §28.13 — encryption-key backup verification staleness warning.
  // Sentry-only; does NOT block boot. Operator might have verified
  // out-of-band and not yet updated the env var.
  if (data.APP_ENCRYPTION_BACKUP_VERIFIED_AT) {
    const verifiedAt = new Date(data.APP_ENCRYPTION_BACKUP_VERIFIED_AT).getTime();
    const ageDays = (Date.now() - verifiedAt) / (1000 * 60 * 60 * 24);
    if (ageDays > 100) {
      // Console breadcrumb is enough — Sentry's beforeBreadcrumb (BP26) picks
      // it up. Avoid a hard `import` of @sentry/nextjs at boot to keep this
      // file dependency-light.
      console.warn(
        `[env-check:warn] APP_ENCRYPTION_BACKUP_VERIFIED_AT is ${Math.floor(ageDays)} days old ` +
          `(> 100). Per §13.5.3 the backup-verification quarterly check should be re-run.`,
      );
    }
  }

  _env = data;
  return _env;
}

export function env(): Env {
  if (!_env) {
    throw new Error("env() called before verifyEnvAtBoot()");
  }
  return _env;
}

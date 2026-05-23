import { z } from "zod";
import { Buffer } from "node:buffer";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GIT_COMMIT_SHA: z.string().optional(),
  PLATFORM_PRIMARY_DOMAIN: z.string().min(1),
  // Regex matching subdomains of PLATFORM_PRIMARY_DOMAIN. Capture group 1
  // must be the slug. Example: ^([a-z0-9-]+)\.aitravelconcierge\.com$
  PLATFORM_DOMAIN_REGEX: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Stripe — key names verified against Stripe docs (stable as of 2026)
  STRIPE_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().min(1),
  // Inngest
  INNGEST_SIGNING_KEY: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().min(1),
  // Service-to-service JWT signing (§8.3)
  SERVICE_JWT_PRIVATE_KEY: z.string().min(1),
  SERVICE_JWT_KEY_ID: z.string().min(1),
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
  RESEND_API_KEY: z.string().optional(),
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
  // OpenAI API key — used for DALL-E 3 hero image generation.
  OPENAI_API_KEY: z.string().optional(),
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
  // Anthropic API key — Haiku for entity extraction & claim grounding checks.
  ANTHROPIC_API_KEY: z.string().optional(),
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
});

type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function verifyEnvAtBoot(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Missing or invalid environment variables:\n${missing}`);
  }
  const data = result.data;
  // §13.5.3 boot-time encryption key validation
  const currentKeyBytes = Buffer.from(data.APP_ENCRYPTION_KEY_CURRENT, "base64");
  if (currentKeyBytes.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY_CURRENT must decode to exactly 32 bytes (got ${currentKeyBytes.length}). ` +
        `Key material is not logged.`,
    );
  }
  if (!data.APP_ENCRYPTION_KEY_ID_CURRENT) {
    throw new Error("APP_ENCRYPTION_KEY_ID_CURRENT must be non-empty.");
  }
  if (data.APP_ENCRYPTION_KEY_PREVIOUS !== undefined) {
    const prevKeyBytes = Buffer.from(data.APP_ENCRYPTION_KEY_PREVIOUS, "base64");
    if (prevKeyBytes.length !== 32) {
      throw new Error(
        `APP_ENCRYPTION_KEY_PREVIOUS must decode to exactly 32 bytes (got ${prevKeyBytes.length}). ` +
          `Key material is not logged.`,
      );
    }
    if (!data.APP_ENCRYPTION_KEY_ID_PREVIOUS) {
      throw new Error(
        "APP_ENCRYPTION_KEY_ID_PREVIOUS must be non-empty when APP_ENCRYPTION_KEY_PREVIOUS is set.",
      );
    }
  }
  // §16.3.4 reserved-parent-domain boot guard. If PLATFORM_PARENT_DOMAIN equals
  // the reserved value AND we are NOT in production, refuse to boot — binding
  // the reserved domain in any non-production project would route every
  // custom-domain tenant's traffic to the wrong project. This guard is one of
  // three layers (boot, before-Vercel-call, annual operator audit).
  if (
    data.PLATFORM_PARENT_DOMAIN &&
    data.PLATFORM_PARENT_DOMAIN === data.RESERVED_PARENT_DOMAIN &&
    data.PLATFORM_ENV !== "production"
  ) {
    throw new Error(
      `[crown-jewel-guard] PLATFORM_PARENT_DOMAIN is set to the reserved value ` +
        `'${data.RESERVED_PARENT_DOMAIN}' but PLATFORM_ENV='${data.PLATFORM_ENV}' is not 'production'. ` +
        `The reserved parent domain MUST only be bound in the production Vercel project (§16.3.4). ` +
        `Refusing to boot.`,
    );
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

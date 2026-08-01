// BP29 / §28 — canonical env-var schema for the RAG service.
//
// Naming-drift waivers vs spec §28 (operator-confirmed during BP29):
//   - `SUPABASE_RAG_*` keeps that prefix order; spec lists `RAG_SUPABASE_*`.
//     Chosen so all Supabase-prefixed vars co-locate in shared .env.local.
//   - `SERVICE_JWT_PUBLIC_KEY` keeps its name; spec lists `INTER_SERVICE_JWT_PUBLIC_KEY`.
//   - `REDIS_URL` used for the jti replay cache; spec lists `INTER_SERVICE_JTI_CACHE_URL`.
// See docs/env-audit.md and MEMORY D-062.

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GIT_COMMIT_SHA: z.string().optional(),
  PLATFORM_PRIMARY_DOMAIN: z.string().min(1),
  // §28.3 — RAG Supabase project (separate from main app — see §6.1).
  SUPABASE_RAG_URL: z.string().url(),
  SUPABASE_RAG_ANON_KEY: z.string().min(1),
  SUPABASE_RAG_SERVICE_ROLE_KEY: z.string().min(1),
  // Spec §28.3 — migration role connection. Optional at boot (CI/operator).
  RAG_SUPABASE_DB_URL: z.string().optional(),
  // §28.6 — OpenAI embeddings. Shape validated; spec requires 1536 dimensions.
  OPENAI_API_KEY: z.string().startsWith("sk-", "must start with sk-").min(1),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .default(1536)
    .refine((v) => v === 1536, { message: "must be 1536 per §6" }),
  // §28.4 — service-to-service JWT verification. Operator-confirmed waiver
  // on naming (SERVICE_JWT_* instead of INTER_SERVICE_JWT_*).
  SERVICE_JWT_PUBLIC_KEY: z.string().min(1),
  // Key ID stamped onto JWTs signed with SERVICE_JWT_PUBLIC_KEY. Required —
  // the verifier maps incoming `kid` headers to the right PEM via this value.
  // Without it, every kid would map to the same PEM (Greptile audit #7).
  SERVICE_JWT_KEY_ID_CURRENT: z.string().min(1),
  // Previous public key during rotation overlap. Optional — present only
  // during the overlap window when keys are being rotated.
  SERVICE_JWT_PUBLIC_KEY_PREVIOUS: z.string().optional(),
  // Required IF SERVICE_JWT_PUBLIC_KEY_PREVIOUS is set. Identifies the kid
  // that maps to the previous PEM during the rotation overlap window.
  SERVICE_JWT_KEY_ID_PREVIOUS: z.string().optional(),
  SERVICE_JWT_ACCEPTED_KEY_IDS: z.string().min(1),
  // §28.4 — jti replay cache for inter-service auth (§8.3 fail-closed contract).
  // Spec name: INTER_SERVICE_JTI_CACHE_URL; code reuses REDIS_URL.
  REDIS_URL: z.string().url(),
  // Nightly reconcile callback to main app (§8.3). #2002 / D-091 #28: rag is
  // the SENDER of this bearer — it presents _CURRENT when set, falling back to
  // the legacy unsuffixed var; the superRefine below requires at least one.
  MAIN_APP_URL: z.string().url(),
  MAIN_APP_ADMIN_API_KEY: z.string().optional(),
  MAIN_APP_ADMIN_API_KEY_CURRENT: z.string().optional(),
  // Inbound tenant-events webhook secret (§8.7)
  RAG_WEBHOOK_SECRET: z.string().min(1),
  // §28.14 — Sentry (optional pending operator provisioning).
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  // §28.1 — Vercel-set deployment env (auto on Vercel; passthrough otherwise).
  VERCEL_ENV: z.string().optional(),
}).superRefine((env, ctx) => {
  // #2002 / D-091 #28 — the admin-seam bearer must be configured under at
  // least one name; both absent means the nightly reconciles silently 401.
  if (!env.MAIN_APP_ADMIN_API_KEY_CURRENT && !env.MAIN_APP_ADMIN_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MAIN_APP_ADMIN_API_KEY_CURRENT"],
      message: "Set MAIN_APP_ADMIN_API_KEY_CURRENT (or legacy MAIN_APP_ADMIN_API_KEY).",
    });
  }
  // If a PREVIOUS public key is set (rotation overlap), the corresponding kid
  // is required so the verifier can route incoming tokens to the right PEM.
  // Without this pair, a rotation overlap would silently accept tokens but
  // verify them against the wrong key — Greptile audit #7 inverted.
  if (env.SERVICE_JWT_PUBLIC_KEY_PREVIOUS && !env.SERVICE_JWT_KEY_ID_PREVIOUS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SERVICE_JWT_KEY_ID_PREVIOUS"],
      message: "Required when SERVICE_JWT_PUBLIC_KEY_PREVIOUS is set (kid→PEM mapping).",
    });
  }
  if (env.SERVICE_JWT_KEY_ID_PREVIOUS && !env.SERVICE_JWT_PUBLIC_KEY_PREVIOUS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SERVICE_JWT_PUBLIC_KEY_PREVIOUS"],
      message: "Required when SERVICE_JWT_KEY_ID_PREVIOUS is set (kid→PEM mapping).",
    });
  }
  // Sanity: both current and previous (when set) kids must appear in the
  // accepted-key-IDs allowlist. A token signed with current kid would be
  // rejected at the kid-allowlist step if SERVICE_JWT_ACCEPTED_KEY_IDS is
  // misconfigured to omit it.
  const acceptedKids = env.SERVICE_JWT_ACCEPTED_KEY_IDS
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!acceptedKids.includes(env.SERVICE_JWT_KEY_ID_CURRENT)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SERVICE_JWT_ACCEPTED_KEY_IDS"],
      message: `Must include SERVICE_JWT_KEY_ID_CURRENT='${env.SERVICE_JWT_KEY_ID_CURRENT}'.`,
    });
  }
  if (env.SERVICE_JWT_KEY_ID_PREVIOUS && !acceptedKids.includes(env.SERVICE_JWT_KEY_ID_PREVIOUS)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SERVICE_JWT_ACCEPTED_KEY_IDS"],
      message: `Must include SERVICE_JWT_KEY_ID_PREVIOUS='${env.SERVICE_JWT_KEY_ID_PREVIOUS}'.`,
    });
  }
});

type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

/**
 * §28.19 boot-time env validation. Surfaces every failure at once so an
 * operator can fix all misconfigurations in a single pass. Caller in
 * instrumentation.ts lets the throw bubble up so Next.js's instrumentation
 * hook crashes the process before any request is served.
 */
export function verifyEnvAtBoot(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  _env = result.data;
  return _env;
}

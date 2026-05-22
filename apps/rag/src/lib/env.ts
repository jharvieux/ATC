import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GIT_COMMIT_SHA: z.string().optional(),
  PLATFORM_PRIMARY_DOMAIN: z.string().min(1),
  // RAG Supabase project (separate from main app — see §6.1).
  // Uses SUPABASE_RAG_* naming to avoid collision with the main app's
  // NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the shared .env.local.
  SUPABASE_RAG_URL: z.string().url(),
  SUPABASE_RAG_ANON_KEY: z.string().min(1),
  SUPABASE_RAG_SERVICE_ROLE_KEY: z.string().min(1),
  // OpenAI embeddings
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_EMBEDDING_DIMENSIONS: z.coerce.number().int().default(1536),
  // Service-to-service JWT verification (§8.3)
  SERVICE_JWT_PUBLIC_KEY: z.string().min(1),
  SERVICE_JWT_ACCEPTED_KEY_IDS: z.string().min(1),
  // Redis — jti replay cache (§8.3 fail-closed contract)
  REDIS_URL: z.string().url(),
  // Nightly reconcile callback to main app (§8.3)
  MAIN_APP_URL: z.string().url(),
  MAIN_APP_ADMIN_API_KEY: z.string().min(1),
  // Inbound tenant-events webhook secret (§8.7)
  RAG_WEBHOOK_SECRET: z.string().min(1),
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
  _env = result.data;
  return _env;
}

export function env(): Env {
  if (!_env) {
    throw new Error("env() called before verifyEnvAtBoot()");
  }
  return _env;
}

import { z } from "zod";

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

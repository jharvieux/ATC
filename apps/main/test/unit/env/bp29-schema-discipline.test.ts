// BP29 §28 schema-discipline meta-tests.
//
// These guard structural invariants that would otherwise be enforced only by
// code review. They walk the Zod schema and the .env.example file directly
// so they catch drift the moment someone introduces it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Re-import the schema constant by extracting it from the file. The schema
// is defined inside env.ts as a module-private const, so to enumerate its
// keys we either need to export it or re-derive the key list. Cleanest:
// import the verifyEnvAtBoot fn and pull keys via .shape on a re-export.
// For now, parse the file as text — robust to schema additions.
const ENV_TS_PATH = resolve(__dirname, "..", "..", "..", "src", "lib", "env.ts");
const ENV_EXAMPLE_PATH = resolve(__dirname, "..", "..", "..", ".env.example");

function readSchemaKeys(): string[] {
  const src = readFileSync(ENV_TS_PATH, "utf8");
  // Match keys of the z.object({...}) shape. Each key is at the start of a
  // line, followed by ': z.' (the Zod chain). Captures the key name.
  const re = /^\s{2}([A-Z][A-Z0-9_]*)\s*:\s*z\./gm;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const k = match[1];
    if (k) keys.push(k);
  }
  return keys;
}

function readEnvExampleKeys(): string[] {
  const src = readFileSync(ENV_EXAMPLE_PATH, "utf8");
  const keys: string[] = [];
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) keys.push(key);
  }
  return keys;
}

function readEnvExampleAllKeys(): string[] {
  // Includes keys that are commented out as `# KEY=value` — these are
  // valid documented vars; the test for parity walks BOTH active and
  // commented forms.
  const src = readFileSync(ENV_EXAMPLE_PATH, "utf8");
  const keys: string[] = [];
  for (const line of src.split("\n")) {
    const stripped = line.replace(/^\s*#\s?/, "").trim();
    if (!stripped) continue;
    const eq = stripped.indexOf("=");
    if (eq < 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) keys.push(key);
  }
  return keys;
}

// Heuristic: a var is "secret-shaped" if its name contains one of these
// substrings. NEXT_PUBLIC_* vars are bundled into the browser; no
// secret-shaped name may carry that prefix.
const SECRET_SUBSTRINGS = [
  "SECRET",
  "PRIVATE_KEY",
  "API_KEY",
  "WEBHOOK_SECRET",
  "SERVICE_ROLE",
  "PEPPER",
  "HMAC",
  "DSN",
  "PUBSUB_VERIFICATION_TOKEN",
];

describe("§28.22 NEXT_PUBLIC_* discipline", () => {
  const keys = readSchemaKeys();
  const publicKeys = keys.filter((k) => k.startsWith("NEXT_PUBLIC_"));

  it("the schema declares at least one NEXT_PUBLIC_* var (sanity)", () => {
    expect(publicKeys.length).toBeGreaterThan(0);
  });

  for (const key of publicKeys) {
    it(`NEXT_PUBLIC_* var '${key}' must not be secret-shaped`, () => {
      const matches = SECRET_SUBSTRINGS.filter((s) => key.includes(s));
      expect(
        matches,
        `${key} contains secret-shaped substring(s) [${matches.join(", ")}] and would leak to the browser`,
      ).toHaveLength(0);
    });
  }
});

describe("§28.18 vendor pricing is NOT in env", () => {
  const keys = readSchemaKeys();

  it("no schema key looks like a per-million pricing value", () => {
    const offenders = keys.filter((k) => /_PRICE_PER_MILLION_/.test(k));
    expect(
      offenders,
      "Vendor pricing must live in platform_settings.ai_pricing_catalog, not env vars. See §27.12 / §28.18.",
    ).toEqual([]);
  });

  it("STRIPE_PRICE_* IDs are allowed (they are Stripe identifiers, not prices)", () => {
    // The naming-collision guard: any STRIPE_PRICE_* that ALSO matches
    // /_PRICE_PER_MILLION_/ would be a contradiction. None should.
    const stripePriceIds = keys.filter((k) => k.startsWith("STRIPE_PRICE_"));
    for (const id of stripePriceIds) {
      expect(id).not.toMatch(/_PRICE_PER_MILLION_/);
    }
  });
});

describe("§28.21 .env.example parity with schema", () => {
  const schemaKeys = new Set(readSchemaKeys());
  const exampleActive = new Set(readEnvExampleKeys());
  const exampleAll = new Set(readEnvExampleAllKeys());

  it(".env.example mentions every schema key (active or commented)", () => {
    const missing = [...schemaKeys].filter((k) => !exampleAll.has(k));
    expect(
      missing,
      `These schema keys are missing from .env.example: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it(".env.example does not introduce unknown vars (active lines)", () => {
    // Active (non-commented) example entries must all correspond to schema
    // keys — guards against typos that would silently get ignored.
    const unknown = [...exampleActive].filter((k) => !schemaKeys.has(k));
    expect(
      unknown,
      `These .env.example active keys are not in the schema: ${unknown.join(", ")}`,
    ).toEqual([]);
  });
});

describe("§28.19 verifyEnvAtBoot surfaces multiple errors at once", () => {
  it("missing both ANTHROPIC_API_KEY and STRIPE_SECRET_KEY surfaces both", async () => {
    // Save + reset module-scope memoization.
    const original = process.env;
    process.env = {
      ...original,
      NODE_ENV: "test",
      PLATFORM_PRIMARY_DOMAIN: "test.example.com",
      PLATFORM_DOMAIN_REGEX: "^([a-z0-9-]+)\\.test\\.example\\.com$",
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_key",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
      INNGEST_SIGNING_KEY: "sk",
      INNGEST_EVENT_KEY: "ek",
      SERVICE_JWT_PRIVATE_KEY: "p",
      SERVICE_JWT_KEY_ID: "v1",
      RAG_SERVICE_URL: "https://rag.test.example.com",
      RAG_WEBHOOK_SECRET: "rs",
      APP_ENCRYPTION_KEY_CURRENT: Buffer.from("a".repeat(32)).toString("base64"),
      APP_ENCRYPTION_KEY_ID_CURRENT: "v1",
      INVITATION_TOKEN_HMAC_KEY: Buffer.from("c".repeat(32)).toString("base64"),
      PLATFORM_PEPPER: "p",
      FORENSICS_ENCRYPTION_KEY_CURRENT: Buffer.from("b".repeat(32)).toString("base64"),
      MICROSOFT_GRAPH_CLIENT_ID: "ms-id",
      MICROSOFT_GRAPH_CLIENT_SECRET: "ms-secret",
      // Intentionally omit: ANTHROPIC_API_KEY and STRIPE_SECRET_KEY.
      ANTHROPIC_API_KEY: undefined,
      STRIPE_SECRET_KEY: undefined,
    } as NodeJS.ProcessEnv;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;

    const { resetModules } = await import("vitest").then((v) => ({
      resetModules: () => v.vi.resetModules(),
    }));
    resetModules();
    const { verifyEnvAtBoot } = await import("@/lib/env");
    try {
      expect(() => verifyEnvAtBoot()).toThrow();
      // Re-throw to capture the actual message
      let caught: unknown;
      try {
        verifyEnvAtBoot();
      } catch (err) {
        caught = err;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/ANTHROPIC_API_KEY/);
      expect(msg).toMatch(/STRIPE_SECRET_KEY/);
    } finally {
      process.env = original;
    }
  });
});

describe("§28.5 ANTHROPIC_API_KEY shape", () => {
  it("rejects malformed ANTHROPIC_API_KEY (no sk-ant- prefix)", async () => {
    const original = process.env;
    const APP_KEY = Buffer.from("a".repeat(32)).toString("base64");
    const FORENSICS_KEY = Buffer.from("b".repeat(32)).toString("base64");
    const HMAC_KEY = Buffer.from("c".repeat(32)).toString("base64");
    process.env = {
      ...original,
      NODE_ENV: "test",
      PLATFORM_PRIMARY_DOMAIN: "test.example.com",
      PLATFORM_DOMAIN_REGEX: "^([a-z0-9-]+)\\.test\\.example\\.com$",
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      STRIPE_SECRET_KEY: "sk_test_x",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_x",
      INNGEST_SIGNING_KEY: "sk",
      INNGEST_EVENT_KEY: "ek",
      SERVICE_JWT_PRIVATE_KEY: "p",
      SERVICE_JWT_KEY_ID: "v1",
      RAG_SERVICE_URL: "https://rag.test.example.com",
      RAG_WEBHOOK_SECRET: "rs",
      APP_ENCRYPTION_KEY_CURRENT: APP_KEY,
      APP_ENCRYPTION_KEY_ID_CURRENT: "v1",
      INVITATION_TOKEN_HMAC_KEY: HMAC_KEY,
      PLATFORM_PEPPER: "p",
      FORENSICS_ENCRYPTION_KEY_CURRENT: FORENSICS_KEY,
      MICROSOFT_GRAPH_CLIENT_ID: "ms-id",
      MICROSOFT_GRAPH_CLIENT_SECRET: "ms-secret",
      ANTHROPIC_API_KEY: "hello-not-an-anthropic-key",
    } as NodeJS.ProcessEnv;
    const { vi } = await import("vitest");
    vi.resetModules();
    const { verifyEnvAtBoot } = await import("@/lib/env");
    try {
      expect(() => verifyEnvAtBoot()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      process.env = original;
    }
  });
});

describe("§28.9 Apple OAuth deferred", () => {
  it("OAUTH_APPLE_ENABLED defaults to false; no Apple vars are required", () => {
    // Verified at the schema level — Apple has no conditional requirement
    // because OAUTH_APPLE_ENABLED defaults to false. This test asserts the
    // schema does not declare Apple-specific creds.
    const keys = readSchemaKeys();
    const appleCredKeys = keys.filter((k) => /^APPLE_/.test(k));
    expect(
      appleCredKeys,
      "Apple OAuth is deferred (§17.1); no Apple-specific creds should be declared.",
    ).toEqual([]);
  });
});


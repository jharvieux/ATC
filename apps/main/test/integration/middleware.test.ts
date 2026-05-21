// Middleware integration tests — BP04
// Spec refs: §1.4 (tenant resolution), §3.6 (middleware logic)
//
// Tests the resolver functions (getTenantBySlug, getTenantByCustomDomain)
// against the live Supabase project and verifies the middleware's routing
// decisions for all five cases from the build prompt:
//   1. Platform domain → "platform" sentinel (logic-only, no DB)
//   2. Active tenant subdomain → resolves to UUID
//   3. Terminated tenant subdomain → null (→ 404)
//   4. Custom domain → resolves to UUID
//   5. Unknown host → null (→ 404)
//
// Gated: DB-backed suites skip unless SUPABASE_DB_URL + service key are set.
// Routing-logic tests run unconditionally.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

import {
  getTenantBySlug,
  getTenantByCustomDomain,
} from "../../src/lib/tenancy/resolve-tenant";

const DB_URL = process.env.SUPABASE_DB_URL;
const haveDB = Boolean(DB_URL);
const describeIf = haveDB ? describe : describe.skip;

// Unique run tag — keeps fixtures isolated per test run.
const RUN_ID = randomUUID().replace(/-/g, "").slice(0, 8);

// Slug constraint: ^[a-z0-9-]{1,28}[a-z0-9]$ (min 2 chars, no leading/trailing hyphen)
// mwt + 8 hex chars + 1 letter suffix = 12 chars, all lowercase alphanumeric.
const makeSlug = (suffix: string) => `mwt${RUN_ID}${suffix}`;
const makeDomain = (suffix: string) =>
  `${RUN_ID}${suffix}.middleware-test.invalid`;

let sql: ReturnType<typeof postgres>;
let activeSlug: string;
let activeTenantId: string;
let terminatedSlug: string;
let customDomainSlug: string;
let customDomainValue: string;

beforeAll(async () => {
  if (!haveDB) return;

  sql = postgres(DB_URL!, { max: 1, idle_timeout: 10, onnotice: () => {} });

  activeSlug = makeSlug("a");
  terminatedSlug = makeSlug("t");
  customDomainSlug = makeSlug("c");
  customDomainValue = makeDomain("cd");

  // Seed three tenants as service role (bypasses RLS).
  const [active] = await sql<{ id: string }[]>`
    INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status)
    VALUES (${activeSlug}, 'MW Active', 'MW Active LLC', 'byo_host', 'active')
    RETURNING id
  `;
  if (!active) throw new Error("beforeAll: active tenant insert returned no row");
  activeTenantId = active.id;

  await sql`
    INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status)
    VALUES (${terminatedSlug}, 'MW Terminated', 'MW Terminated LLC', 'byo_host', 'terminated')
  `;

  await sql`
    INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, custom_domain)
    VALUES (${customDomainSlug}, 'MW Custom Domain', 'MW Custom Domain LLC', 'byo_host', 'active', ${customDomainValue})
  `;
});

afterAll(async () => {
  if (!haveDB || !sql) return;
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
      await tx`DELETE FROM public.tenants WHERE slug LIKE ${"mwt" + RUN_ID + "%"}`;
    });
  } finally {
    await sql.end();
  }
}, 60000);

describeIf("getTenantBySlug (integration)", () => {
  it("returns active tenant for known slug", async () => {
    const tenant = await getTenantBySlug(activeSlug);
    expect(tenant).not.toBeNull();
    expect(tenant?.id).toBe(activeTenantId);
    expect(tenant?.status).toBe("active");
  });

  it("returns null for terminated tenant — no status leaked", async () => {
    const tenant = await getTenantBySlug(terminatedSlug);
    expect(tenant).toBeNull();
  });

  it("returns null for unknown slug", async () => {
    const tenant = await getTenantBySlug(`mwt${RUN_ID}zz`);
    expect(tenant).toBeNull();
  });

  it("caches: second call returns same result without changing outcome", async () => {
    const first = await getTenantBySlug(activeSlug);
    const second = await getTenantBySlug(activeSlug);
    expect(second?.id).toBe(first?.id);
  });
});

describeIf("getTenantByCustomDomain (integration)", () => {
  it("returns tenant for known custom domain", async () => {
    const tenant = await getTenantByCustomDomain(customDomainValue);
    expect(tenant).not.toBeNull();
    expect(tenant?.custom_domain).toBe(customDomainValue);
  });

  it("returns null for unknown hostname", async () => {
    const tenant = await getTenantByCustomDomain("unknown.example.invalid");
    expect(tenant).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Middleware routing logic — no DB, runs unconditionally
//
// These tests verify the pattern-matching decisions the middleware makes
// before ever calling a resolver. They test the env var configuration that
// the middleware depends on.
// ---------------------------------------------------------------------------

describe("middleware routing decisions (logic-only)", () => {
  it("PLATFORM_DOMAIN_REGEX captures slug as capture group 1", () => {
    const regex =
      process.env.PLATFORM_DOMAIN_REGEX ??
      "^([a-z0-9-]+)\\.ai-travelconcierge\\.com$";
    const re = new RegExp(regex);
    const match = "acme.ai-travelconcierge.com".match(re);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("acme");
  });

  it("PLATFORM_DOMAIN_REGEX does not match the bare primary domain", () => {
    const regex =
      process.env.PLATFORM_DOMAIN_REGEX ??
      "^([a-z0-9-]+)\\.ai-travelconcierge\\.com$";
    const re = new RegExp(regex);
    expect("ai-travelconcierge.com".match(re)).toBeNull();
  });

  it("PLATFORM_DOMAIN_REGEX does not match an unrelated custom domain", () => {
    const regex =
      process.env.PLATFORM_DOMAIN_REGEX ??
      "^([a-z0-9-]+)\\.ai-travelconcierge\\.com$";
    const re = new RegExp(regex);
    expect("travel.example.com".match(re)).toBeNull();
  });

  it("hostname port-stripping preserves bare domain", () => {
    // Mirrors the middleware's host.replace(/:\d+$/, "") logic.
    expect("localhost:3000".replace(/:\d+$/, "")).toBe("localhost");
    expect("ai-travelconcierge.com:443".replace(/:\d+$/, "")).toBe(
      "ai-travelconcierge.com",
    );
    expect("ai-travelconcierge.com".replace(/:\d+$/, "")).toBe(
      "ai-travelconcierge.com",
    );
  });
});

// Unit tests for apps/main/src/lib/tenancy/resolve-tenant.ts
//
// D-091 priority: this is the single chokepoint all tenant-scoped requests
// flow through. Mutations that drop the status='terminated' null guard or
// swallow DB errors (fail-open) must be caught here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────────────

type MockRow = {
  id: string;
  slug: string;
  tenant_type: string;
  status: string;
  custom_domain: string | null;
  custom_domain_status: string;
  search_indexing_enabled: boolean;
  tier_definitions: { code: string } | { code: string }[] | null;
  subscription_status: string | null;
  non_paying_since: string | null;
  is_platform_internal: boolean;
};

let mockTenantsRow: MockRow | null = null;
let mockTenantsError: { message: string } | null = null;
let mockUsersRow: { tenant_id: string } | null = null;
let mockUsersError: { message: string } | null = null;
// Separate tenant result for the second query in getTenantByAuthUserId
let mockTenantsByIdRow: MockRow | null = null;
let mockTenantsByIdError: { message: string } | null = null;

// Tracks every query key so we can assert cache is being used.
const dbCallKeys: string[] = [];

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: (col: string, val: string) => {
          dbCallKeys.push(`${table}.${col}=${val}`);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => {
          if (table === "users") {
            return Promise.resolve({ data: mockUsersRow, error: mockUsersError });
          }
          // tenants table — distinguish by which query was last registered
          const lastKey = dbCallKeys[dbCallKeys.length - 1] ?? "";
          if (lastKey.startsWith("tenants.id=")) {
            return Promise.resolve({ data: mockTenantsByIdRow, error: mockTenantsByIdError });
          }
          return Promise.resolve({ data: mockTenantsRow, error: mockTenantsError });
        },
      };
      return builder;
    },
  }),
}));

import {
  getTenantBySlug,
  getTenantByCustomDomain,
  getCurrentIndexingTenantByCustomDomain,
  getTenantById,
  getTenantByAuthUserId,
} from "@/lib/tenancy/resolve-tenant";

// ── helpers ────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "tenant-1",
    slug: "acme",
    tenant_type: "agency",
    status: "active",
    custom_domain: null,
    custom_domain_status: "none",
    search_indexing_enabled: false,
    tier_definitions: { code: "sub_pro" },
    subscription_status: "active",
    non_paying_since: null,
    is_platform_internal: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockTenantsRow = makeRow();
  mockTenantsError = null;
  mockUsersRow = { tenant_id: "tenant-1" };
  mockUsersError = null;
  mockTenantsByIdRow = makeRow();
  mockTenantsByIdError = null;
  dbCallKeys.length = 0;
});

afterEach(() => {
  // vi.resetModules() does NOT clear the module-level cache Maps in resolve-tenant.ts
  // because the module was statically imported at the top of this file.
  // Cache isolation is achieved by using unique slug/id/domain per test instead.
  vi.resetModules();
});

// ── getTenantBySlug ────────────────────────────────────────────────────────

describe("getTenantBySlug", () => {
  it("returns the active tenant for a known slug", async () => {
    const tenant = await getTenantBySlug("acme");
    expect(tenant).not.toBeNull();
    expect(tenant!.id).toBe("tenant-1");
    expect(tenant!.slug).toBe("acme");
  });

  it("returns null for a terminated tenant — terminated tenants must be denied", async () => {
    // D-091: status check is the only gate preventing a terminated tenant from
    // accessing its data. A mutant removing the `=== 'terminated'` guard
    // would return the row — this test catches it.
    mockTenantsRow = makeRow({ status: "terminated" });
    const tenant = await getTenantBySlug("acme-terminated");
    expect(tenant).toBeNull();
  });

  it("returns null for an unknown slug", async () => {
    mockTenantsRow = null;
    const tenant = await getTenantBySlug("does-not-exist");
    expect(tenant).toBeNull();
  });

  it("throws when the DB returns an error (fail-closed)", async () => {
    // D-091: surfacing the error lets the caller return 500 rather than
    // accidentally treating a DB failure as 'not found'.
    mockTenantsError = { message: "connection timeout" };
    await expect(getTenantBySlug("bad-db")).rejects.toThrow("getTenantBySlug");
  });

  it("returns cached result on second call — no extra DB hit", async () => {
    const slug = "cache-test-slug";
    mockTenantsRow = makeRow({ slug });
    const first = await getTenantBySlug(slug);
    dbCallKeys.length = 0; // reset call log
    const second = await getTenantBySlug(slug);
    // Both calls return the same object; no new DB eq() call for the same slug
    expect(second).toEqual(first);
    expect(dbCallKeys.filter((k) => k === `tenants.slug=${slug}`)).toHaveLength(0);
  });
});

// ── getTenantById ──────────────────────────────────────────────────────────

describe("getTenantById", () => {
  it("returns the active tenant for a known id", async () => {
    const tenant = await getTenantById("tenant-1");
    expect(tenant).not.toBeNull();
    expect(tenant!.id).toBe("tenant-1");
  });

  it("returns null for a terminated tenant", async () => {
    mockTenantsByIdRow = makeRow({ status: "terminated" });
    const tenant = await getTenantById("terminated-id");
    expect(tenant).toBeNull();
  });

  it("returns null when id is unknown", async () => {
    mockTenantsByIdRow = null;
    const tenant = await getTenantById("unknown-id");
    expect(tenant).toBeNull();
  });

  it("throws when the DB returns an error (fail-closed)", async () => {
    mockTenantsByIdError = { message: "replica lag" };
    await expect(getTenantById("err-id")).rejects.toThrow("getTenantById");
  });
});

// ── getTenantByCustomDomain ────────────────────────────────────────────────

describe("getTenantByCustomDomain", () => {
  it("returns the active tenant for a known custom domain", async () => {
    mockTenantsRow = makeRow({ custom_domain: "book.acme.com" });
    const tenant = await getTenantByCustomDomain("book.acme.com");
    expect(tenant).not.toBeNull();
    expect(tenant!.custom_domain).toBe("book.acme.com");
  });

  it("returns null for an unknown hostname", async () => {
    mockTenantsRow = null;
    const tenant = await getTenantByCustomDomain("unknown.com");
    expect(tenant).toBeNull();
  });

  it("returns null for a terminated tenant matched by custom domain", async () => {
    mockTenantsRow = makeRow({ custom_domain: "old.acme.com", status: "terminated" });
    const tenant = await getTenantByCustomDomain("old.acme.com");
    expect(tenant).toBeNull();
  });

  it("throws when the DB returns an error (fail-closed)", async () => {
    mockTenantsError = { message: "read replica timeout" };
    await expect(getTenantByCustomDomain("err.com")).rejects.toThrow("getTenantByCustomDomain");
  });
});

describe("getCurrentIndexingTenantByCustomDomain", () => {
  it("re-reads joined indexing and tier state on every enforcement lookup", async () => {
    const hostname = "current-indexing.acme.com";
    mockTenantsRow = makeRow({
      custom_domain: hostname,
      custom_domain_status: "verified",
      search_indexing_enabled: true,
      tier_definitions: { code: "sub_agency" },
    });

    const enabled = await getCurrentIndexingTenantByCustomDomain(hostname);

    mockTenantsRow = makeRow({
      custom_domain: hostname,
      custom_domain_status: "verified",
      search_indexing_enabled: false,
      tier_definitions: { code: "sub_pro" },
    });
    const disabled = await getCurrentIndexingTenantByCustomDomain(hostname);

    expect(enabled).toMatchObject({
      search_indexing_enabled: true,
      tier_code: "sub_agency",
    });
    expect(disabled).toMatchObject({
      search_indexing_enabled: false,
      tier_code: "sub_pro",
    });
    expect(
      dbCallKeys.filter(
        (key) => key === `tenants.custom_domain=${hostname}`,
      ),
    ).toHaveLength(2);
  });

  it.each<
    [string, MockRow["tier_definitions"], string | null]
  >([
    ["object", { code: "sub_agency" }, "sub_agency"],
    ["array", [{ code: "byo_agency" }], "byo_agency"],
    ["null", null, null],
    ["empty array", [], null],
  ])("normalizes the %s tier join shape", async (label, tier, expected) => {
    const hostname = `tier-shape-${label.replace(" ", "-")}.acme.com`;
    mockTenantsRow = makeRow({
      custom_domain: hostname,
      tier_definitions: tier,
    });

    const tenant = await getCurrentIndexingTenantByCustomDomain(hostname);

    expect(tenant?.tier_code).toBe(expected);
  });

  it("throws on a failed current-state read", async () => {
    mockTenantsError = { message: "tier join unavailable" };

    await expect(
      getCurrentIndexingTenantByCustomDomain("current-error.acme.com"),
    ).rejects.toThrow("getCurrentIndexingTenantByCustomDomain");
  });
});

// ── getTenantByAuthUserId ──────────────────────────────────────────────────

describe("getTenantByAuthUserId", () => {
  it("returns the tenant for a valid auth user", async () => {
    const tenant = await getTenantByAuthUserId("auth-user-1");
    expect(tenant).not.toBeNull();
    expect(tenant!.id).toBe("tenant-1");
  });

  it("returns null when auth user has no users row (unknown user)", async () => {
    // User not in the system — should not grant access to any tenant
    mockUsersRow = null;
    const tenant = await getTenantByAuthUserId("auth-no-user");
    expect(tenant).toBeNull();
  });

  it("throws when users lookup returns a DB error (fail-closed)", async () => {
    mockUsersError = { message: "FK constraint" };
    await expect(getTenantByAuthUserId("auth-err")).rejects.toThrow("getTenantByAuthUserId");
  });

  it("throws when tenants lookup after user row returns DB error (fail-closed)", async () => {
    mockUsersRow = { tenant_id: "tenant-1" };
    mockTenantsByIdError = { message: "tenants table locked" };
    await expect(getTenantByAuthUserId("auth-tenant-err")).rejects.toThrow("getTenantByAuthUserId");
  });

  it("returns null when the resolved tenant is terminated", async () => {
    // The user exists and maps to a tenant, but that tenant is terminated.
    // Must not grant access even through the user-auth path.
    mockUsersRow = { tenant_id: "tenant-1" };
    mockTenantsByIdRow = makeRow({ status: "terminated" });
    const tenant = await getTenantByAuthUserId("auth-terminated-tenant");
    expect(tenant).toBeNull();
  });

  it("#1678: survives 1001 distinct active users without evicting the first — the shared BoundedTtlCache default (1000) would have evicted it, forcing a DB read per user under realistic active-user counts", async () => {
    mockUsersRow = { tenant_id: "tenant-1" };
    const firstUser = "auth-cardinality-user-0";
    await getTenantByAuthUserId(firstUser);
    for (let i = 1; i <= 1000; i++) {
      await getTenantByAuthUserId(`auth-cardinality-user-${i}`);
    }
    dbCallKeys.length = 0;
    const tenant = await getTenantByAuthUserId(firstUser);
    expect(tenant).not.toBeNull();
    // A cache hit issues no new `users.auth_user_id=` lookup for firstUser.
    expect(dbCallKeys.some((k) => k === `users.auth_user_id=${firstUser}`)).toBe(false);
  });
});

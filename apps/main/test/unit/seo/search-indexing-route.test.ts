import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  permissionDenied: false,
  tenant: {
    tier_id: "tier-agency",
    custom_domain: "harborlighttravel.com" as string | null,
    custom_domain_status: "verified",
    search_indexing_enabled: false,
  },
  tier: { code: "byo_agency" },
  updatedValue: null as boolean | null,
  auditCalls: 0,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => {
    if (h.permissionDenied) throw new Error("permission_denied");
    return {
      ctx: {
        tenant_id: "tenant-1",
        source: { kind: "http_request", user_id: "user-1" },
      },
    };
  }),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: () =>
    Response.json({ error: "permission_denied" }, { status: 403 }),
}));

vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: () => Response.json({ error: "db_error" }, { status: 500 }),
}));

function chainFor(table: string) {
  let update: Record<string, unknown> | null = null;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.update = (value: Record<string, unknown>) => {
    update = value;
    h.updatedValue = value.search_indexing_enabled as boolean;
    return chain;
  };
  const resolve = () => {
    if (update) {
      return {
        data: { search_indexing_enabled: update.search_indexing_enabled },
        error: null,
      };
    }
    return {
      data: table === "tenants" ? h.tenant : h.tier,
      error: null,
    };
  };
  chain.maybeSingle = async () => resolve();
  chain.single = async () => resolve();
  return chain;
}

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({ from: (table: string) => chainFor(table) }),
}));

vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: async () => {
    h.auditCalls += 1;
  },
}));

import { GET, POST } from "@/app/api/tenant/search-indexing/route";

function request(method = "GET", body?: unknown): Request {
  return new Request("https://harborlighttravel.com/api/tenant/search-indexing", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  h.permissionDenied = false;
  h.tenant = {
    tier_id: "tier-agency",
    custom_domain: "harborlighttravel.com",
    custom_domain_status: "verified",
    search_indexing_enabled: false,
  };
  h.tier = { code: "byo_agency" };
  h.updatedValue = null;
  h.auditCalls = 0;
});

describe("tenant search-indexing setting", () => {
  it("reports Agency eligibility and the disabled default", async () => {
    const res = await GET(request());
    const body = (await res.json()) as {
      agency_eligible: boolean;
      search_indexing_enabled: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.agency_eligible).toBe(true);
    expect(body.search_indexing_enabled).toBe(false);
  });

  it("enables indexing for an Agency tenant with a verified custom domain", async () => {
    const res = await POST(
      request("POST", { search_indexing_enabled: true }),
    );

    expect(res.status).toBe(200);
    expect(h.updatedValue).toBe(true);
    expect(h.auditCalls).toBe(1);
  });

  it("persists the disabled state", async () => {
    h.tenant.search_indexing_enabled = true;

    const res = await POST(
      request("POST", { search_indexing_enabled: false }),
    );

    expect(res.status).toBe(200);
    expect(h.updatedValue).toBe(false);
  });

  it("rejects opt-in until the custom domain is verified", async () => {
    h.tenant.custom_domain_status = "pending_verification";

    const res = await POST(
      request("POST", { search_indexing_enabled: true }),
    );

    expect(res.status).toBe(409);
    expect(h.updatedValue).toBeNull();
  });

  it("rejects the toggle outside Agency tiers", async () => {
    h.tier = { code: "sub_pro" };

    const res = await POST(
      request("POST", { search_indexing_enabled: true }),
    );

    expect(res.status).toBe(403);
    expect(h.updatedValue).toBeNull();
  });

  it("rejects non-boolean setting values", async () => {
    const res = await POST(
      request("POST", { search_indexing_enabled: "true" }),
    );

    expect(res.status).toBe(422);
    expect(h.updatedValue).toBeNull();
  });

  it("keeps the route owner-gated", async () => {
    h.permissionDenied = true;

    expect((await POST(request("POST", { search_indexing_enabled: true }))).status)
      .toBe(403);
    expect(h.updatedValue).toBeNull();
  });
});

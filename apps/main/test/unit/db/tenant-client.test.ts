// Spec ref: §5.4.3 (Proxy wrapper)
//
// These tests verify that tenantClient transparently scopes queries against
// tables in TENANT_SCOPED_TABLES and passes through tables that are NOT in
// the set. Supabase JS is mocked — no real DB calls.

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the service-role client BEFORE importing the SUT, so the Proxy
// wraps our mock instead of a real Supabase client.
const mockFrom = vi.fn();
const mockClient = { from: mockFrom };

vi.mock("../../../src/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => mockClient,
}));

import { tenantClient } from "../../../src/lib/db/tenant-client";
import type { TenantContext } from "../../../src/lib/db/tenant-context";

const ctx: TenantContext = {
  tenant_id: "tenant-abc",
  source: { kind: "http_request", user_id: "user-1" },
};

function makeQueryBuilder() {
  // Each operation method returns a "filter builder" that records the
  // .eq calls so we can assert on them.
  const eqCalls: Array<[string, unknown]> = [];
  const filterBuilder = {
    eqCalls,
    eq(col: string, val: unknown) {
      eqCalls.push([col, val]);
      return filterBuilder;
    },
  };
  const select = vi.fn(() => filterBuilder);
  const update = vi.fn(() => filterBuilder);
  const del = vi.fn(() => filterBuilder);
  const insert = vi.fn();
  const upsert = vi.fn();
  return { filterBuilder, select, update, delete: del, insert, upsert };
}

beforeEach(() => {
  mockFrom.mockReset();
});

describe("tenantClient proxy", () => {
  it("scopes .from('bookings').select() with eq('tenant_id', ctx.tenant_id)", () => {
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("bookings").select("*");

    expect(mockFrom).toHaveBeenCalledWith("bookings");
    expect(qb.select).toHaveBeenCalledWith("*");
    expect(qb.filterBuilder.eqCalls).toEqual([["tenant_id", "tenant-abc"]]);
  });

  it("scopes .from('bookings').update(...) with the tenant filter", () => {
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("bookings").update({ status: "confirmed" });

    expect(qb.update).toHaveBeenCalledWith({ status: "confirmed" });
    expect(qb.filterBuilder.eqCalls).toEqual([["tenant_id", "tenant-abc"]]);
  });

  it("scopes .from('bookings').delete() with the tenant filter", () => {
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("bookings").delete();

    expect(qb.delete).toHaveBeenCalled();
    expect(qb.filterBuilder.eqCalls).toEqual([["tenant_id", "tenant-abc"]]);
  });

  it("injects tenant_id into .from('bookings').insert(row)", () => {
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("bookings").insert({ status: "draft" });

    expect(qb.insert).toHaveBeenCalledWith({
      status: "draft",
      tenant_id: "tenant-abc",
    });
  });

  it("injects tenant_id into every row of .from('bookings').insert(array)", () => {
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("bookings").insert([{ status: "a" }, { status: "b" }]);

    expect(qb.insert).toHaveBeenCalledWith([
      { status: "a", tenant_id: "tenant-abc" },
      { status: "b", tenant_id: "tenant-abc" },
    ]);
  });

  it("does NOT scope queries against tables not in TENANT_SCOPED_TABLES", () => {
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("tier_definitions").select("*");

    expect(mockFrom).toHaveBeenCalledWith("tier_definitions");
    expect(qb.select).toHaveBeenCalledWith("*");
    // No tenant filter applied — passthrough.
    expect(qb.filterBuilder.eqCalls).toEqual([]);
  });
});

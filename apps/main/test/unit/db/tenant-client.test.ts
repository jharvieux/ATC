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

  // @rls-covered-by resources=table:public.bookings target=apps/main/test/integration/rls.test.ts#RLS integration BP05 domain tables RLS bookings: userB cannot SELECT tenantA rows
  it("scopes .from('bookings').update(...) with the tenant filter", () => {
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("bookings").update({ status: "confirmed" });

    expect(qb.update).toHaveBeenCalledWith({ status: "confirmed" });
    expect(qb.filterBuilder.eqCalls).toEqual([["tenant_id", "tenant-abc"]]);
  });

  // @rls-covered-by resources=table:public.bookings target=apps/main/test/integration/rls.test.ts#RLS integration BP05 domain tables RLS bookings: userB cannot SELECT tenantA rows
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

  it("passes through queries against PLATFORM_READABLE_TABLES without auto-scoping", () => {
    // `tier_definitions` has no tenant_id column — callers self-scope.
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("tier_definitions").select("*");

    expect(mockFrom).toHaveBeenCalledWith("tier_definitions");
    expect(qb.select).toHaveBeenCalledWith("*");
    // No tenant filter applied — platform-readable passthrough.
    expect(qb.filterBuilder.eqCalls).toEqual([]);
  });

  it("passes through .from('legal_documents') — global versioned legal catalog has no tenant_id column", () => {
    // Regression: legal_documents was wrongly in TENANT_SCOPED_TABLES, so the
    // proxy injected `.eq("tenant_id", …)` against a table with no such column.
    // Postgres hard-errors "column legal_documents.tenant_id does not exist",
    // which 500'd the onboarding legal-accept step and blocked signup.
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("legal_documents").select("id, document_type, version");

    expect(mockFrom).toHaveBeenCalledWith("legal_documents");
    expect(qb.filterBuilder.eqCalls).toEqual([]);
  });

  it("passes through .from('personas') — the global persona catalog (#589 switch route depends on this)", () => {
    // personas has no tenant_id (global catalog). De-registering it would make
    // tenantClient.from('personas') throw, 500-ing the persona-switch route.
    const qb = makeQueryBuilder();
    mockFrom.mockReturnValue(qb);

    const db = tenantClient(ctx);
    db.from("personas").select("id");

    expect(mockFrom).toHaveBeenCalledWith("personas");
    expect(qb.filterBuilder.eqCalls).toEqual([]);
  });

  // #1054 — five tables that were wrongly in TENANT_SCOPED_TABLES despite
  // having no tenant_id column (the #1045 bug class). `invitations` is the live
  // trap: its three tenantClient callers (groups/[id], /members, /broadcast)
  // verify group ownership via a tenant-scoped `groups` query, then filter by
  // group_id — so the injected `.eq("tenant_id", …)` was both wrong (no column →
  // 500) and redundant. The other four are service-role-only today (dormant
  // traps), but a future tenantClient caller would have hit the same hard-error.
  // Each must pass through WITHOUT a tenant filter.
  for (const table of [
    "invitations",
    "rag_global_promotions",
    "auth_attempts",
    "security_incidents",
    "staging_cron_skips",
  ]) {
    it(`passes through .from('${table}') — no tenant_id column (#1054)`, () => {
      const qb = makeQueryBuilder();
      mockFrom.mockReturnValue(qb);

      const db = tenantClient(ctx);
      db.from(table).select("*");

      expect(mockFrom).toHaveBeenCalledWith(table);
      expect(qb.filterBuilder.eqCalls).toEqual([]);
    });
  }

  // #903 / D-193 — voice-profile tables were never registered, so the proxy
  // threw UnregisteredTenantTableError at .from() and the settings/voice page
  // 500'd ("Load failed (HTTP 500)") with no query ever reaching the DB. Both
  // carry a tenant_id column, so they must scope, not throw or pass through.
  for (const table of ["voice_samples", "voice_profiles"]) {
    it(`scopes .from('${table}').select() with the tenant filter (#903)`, () => {
      const qb = makeQueryBuilder();
      mockFrom.mockReturnValue(qb);

      const db = tenantClient(ctx);
      db.from(table).select("*");

      expect(mockFrom).toHaveBeenCalledWith(table);
      expect(qb.filterBuilder.eqCalls).toEqual([["tenant_id", "tenant-abc"]]);
    });
  }

  it("THROWS on tables in neither TENANT_SCOPED_TABLES nor PLATFORM_READABLE_TABLES", () => {
    // Fail-closed contract — see UnregisteredTenantTableError.
    mockFrom.mockReturnValue(makeQueryBuilder());

    const db = tenantClient(ctx);
    expect(() => db.from("this_table_does_not_exist_anywhere")).toThrow(
      /refusing to access table 'this_table_does_not_exist_anywhere'/,
    );
    // .from() throws before reaching the underlying client.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("THROWS when callers access .rpc — bypassing the proxy is the bug we're preventing", () => {
    const db = tenantClient(ctx);
    expect(() => (db as unknown as { rpc: () => unknown }).rpc).toThrow(
      /refusing to expose 'rpc'/,
    );
  });

  it("THROWS when callers access .schema — same reason", () => {
    const db = tenantClient(ctx);
    expect(() => (db as unknown as { schema: () => unknown }).schema).toThrow(
      /refusing to expose 'schema'/,
    );
  });
});

// #1789 — per-tenant approved/rejected counts were parallelized via
// mapWithConcurrency (previously one tenant at a time). The risk that
// matters here isn't latency, it's attribution: if a future refactor let
// concurrent workers share mutable state, one tenant's counts could leak
// into another's aggregate row. This test pins that each tenant's
// approval_rate is computed strictly from its own counts, for multiple
// tenants processed concurrently, and that zero-activity tenants are
// dropped rather than emitting a divide-by-zero or a bogus row.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  excludeNonPayingPastGrace: (rows: unknown[]) => rows,
}));

interface TenantCounts {
  approved: number;
  rejected: number;
}

let tenants: Array<{ id: string; status: string }>;
let countsByTenant: Record<string, TenantCounts>;

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: tenants, error: null }),
          }),
        };
      }
      // rag_submissions — count query, filtered by tenant_id + review_status.
      const filters: Record<string, string> = {};
      const chain = {
        select: () => chain,
        eq(col: string, val: string) {
          filters[col] = val;
          return chain;
        },
        gte: () => chain,
        then(resolve: (v: unknown) => unknown) {
          const tenantId = filters.tenant_id!;
          const status = filters.review_status as "approved" | "rejected";
          // Simulate real async latency so concurrent workers genuinely
          // interleave instead of resolving in dispatch order.
          const delayMs = tenantId === "t-1" ? 10 : 0;
          return Promise.resolve().then(async () => {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            resolve({ count: countsByTenant[tenantId]?.[status] ?? 0, error: null });
          });
        },
      };
      return chain;
    },
  }),
}));

async function runCron(): Promise<unknown> {
  vi.resetModules();
  const mod = (await import("@/inngest/rag-tenant-approval-rate-nightly")) as unknown as {
    ragTenantApprovalRateNightly: { __handler: () => Promise<unknown> };
  };
  return mod.ragTenantApprovalRateNightly.__handler();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ragTenantApprovalRateNightly — concurrent per-tenant aggregation (#1789)", () => {
  it("attributes counts to the correct tenant even when tenants resolve out of order", async () => {
    // t-1 is the slow one (artificial delay), so if attribution were ever
    // keyed by completion order instead of tenant_id, t-1's counts would
    // land on the wrong tenant.
    tenants = [
      { id: "t-1", status: "active" },
      { id: "t-2", status: "active" },
      { id: "t-3", status: "active" },
    ];
    countsByTenant = {
      "t-1": { approved: 8, rejected: 2 },
      "t-2": { approved: 1, rejected: 9 },
      "t-3": { approved: 5, rejected: 5 },
    };

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = (await runCron()) as { ok: boolean; tenants_aggregated: number };
    expect(result).toEqual({ ok: true, tenants_aggregated: 3 });

    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.find((l) => l.includes("tenant=t-1"))).toContain(
      "approval_rate=0.80 approved=8 rejected=2",
    );
    expect(logs.find((l) => l.includes("tenant=t-2"))).toContain(
      "approval_rate=0.10 approved=1 rejected=9",
    );
    expect(logs.find((l) => l.includes("tenant=t-3"))).toContain(
      "approval_rate=0.50 approved=5 rejected=5",
    );
    infoSpy.mockRestore();
  });

  it("drops tenants with zero approved+rejected instead of emitting a bogus row", async () => {
    tenants = [
      { id: "t-1", status: "active" },
      { id: "t-2", status: "active" },
    ];
    countsByTenant = {
      "t-1": { approved: 0, rejected: 0 },
      "t-2": { approved: 3, rejected: 1 },
    };

    const result = (await runCron()) as { ok: boolean; tenants_aggregated: number };
    // Only t-2 had activity — t-1 must not appear in the aggregate count.
    expect(result).toEqual({ ok: true, tenants_aggregated: 1 });
  });
});

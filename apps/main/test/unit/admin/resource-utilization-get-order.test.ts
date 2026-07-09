// Route-level guard for the paginated ai_call_log read in
// GET /api/admin/resource-utilization.
//
// WHY: a .range() page read WITHOUT a deterministic total order lets
// PostgREST return the same row on two pages or skip one, which double-counts
// or under-counts 30-day AI cost. This pins that the route's ai_call_log query
// chains .order("created_at") THEN .order("id") (PK tiebreaker) BEFORE
// .range() — if a future edit drops either order, this test fails.

import { describe, it, expect, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  // Per-table record of the method chain the route built, so we can inspect
  // exactly how ai_call_log was queried.
  recordedCalls: {} as Record<string, Array<[string, ...unknown[]]>>,
}));

vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  return {
    ...actual,
    assertPlatformAdminArea: vi.fn(async () => ({
      admin_user_id: "admin-1",
      role: "finance" as const,
      via: "session" as const,
    })),
  };
});

// rag-fetch is exercised elsewhere; here it just needs to resolve to empty.
vi.mock("@/app/api/admin/resource-utilization/rag-fetch", () => ({
  fetchRagEmbeddingRows: vi.fn(async () => ({ daily: [], byModel: [], tenantPeriod: new Map() })),
  periodStartIso: vi.fn(() => "2026-07-01T00:00:00Z"),
}));

// A single chainable + thenable query-builder stub that serves every table the
// GET handler reads. It records each method call for the given table and
// resolves to that table's canned result whether the caller awaits the builder
// directly (thenable) or terminates on .range()/.maybeSingle().
function resultFor(table: string): { data: unknown; error: null } {
  if (table === "ai_call_log") {
    return {
      data: [
        { created_at: "2026-07-01T00:00:00Z", vendor: "anthropic", model: "claude", input_tokens: 1, output_tokens: 1, cost_estimate_cents: 1 },
        { created_at: "2026-07-02T00:00:00Z", vendor: "anthropic", model: "claude", input_tokens: 1, output_tokens: 1, cost_estimate_cents: 1 },
      ],
      error: null,
    };
  }
  if (table === "platform_settings") return { data: null, error: null };
  return { data: [], error: null };
}

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts: unknown, fn: (db: unknown, rq: unknown) => Promise<unknown>) => {
    const db = {
      from(table: string) {
        const calls: Array<[string, ...unknown[]]> = [];
        hoisted.recordedCalls[table] = calls;
        const result = resultFor(table);
        const chain: Record<string, unknown> = {
          select: (...a: unknown[]) => { calls.push(["select", ...a]); return chain; },
          gte: (...a: unknown[]) => { calls.push(["gte", ...a]); return chain; },
          in: (...a: unknown[]) => { calls.push(["in", ...a]); return chain; },
          eq: (...a: unknown[]) => { calls.push(["eq", ...a]); return chain; },
          order: (...a: unknown[]) => { calls.push(["order", ...a]); return chain; },
          range: (...a: unknown[]) => { calls.push(["range", ...a]); return Promise.resolve(result); },
          maybeSingle: () => Promise.resolve(result),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(result).then(res, rej),
        };
        return chain;
      },
    };
    return fn(db, () => {});
  }),
}));

describe("GET /api/admin/resource-utilization — ai_call_log page ordering (BLOCKER)", () => {
  it("orders by created_at then id (PK tiebreaker) BEFORE .range() so pages can't double-count or drop rows", async () => {
    const { GET } = await import("@/app/api/admin/resource-utilization/route");
    const res = await GET(new Request("http://test/api/admin/resource-utilization"));
    expect(res.status).toBe(200);

    const calls = hoisted.recordedCalls["ai_call_log"];
    expect(calls).toBeDefined();

    const orderCalls = calls!.filter((c) => c[0] === "order");
    const rangeIdx = calls!.findIndex((c) => c[0] === "range");
    const orderIdxs = calls!.map((c, i) => (c[0] === "order" ? i : -1)).filter((i) => i >= 0);

    // Two order keys: created_at first, id second.
    expect(orderCalls).toEqual([
      ["order", "created_at", { ascending: true }],
      ["order", "id", { ascending: true }],
    ]);
    // Both orders precede the range — a range without a preceding total order
    // is the exact non-determinism this guards against.
    expect(rangeIdx).toBeGreaterThan(-1);
    for (const oi of orderIdxs) expect(oi).toBeLessThan(rangeIdx);
  });
});

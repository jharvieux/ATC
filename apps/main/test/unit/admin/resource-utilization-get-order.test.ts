// Route-level guard for the ai_call_log rollup in
// GET /api/admin/resource-utilization.
//
// WHY (#1698): the 30-day AI cost used to be read row-by-row via .range()
// paging, then aggregated in JS. It is now aggregated DB-side by two RPCs
// (ai_call_log_daily_cost_rollup + ai_call_log_model_rollup). This pins that
// the route calls BOTH RPCs over a date range and that their pre-aggregated
// results flow into the dashboard response — if a future edit reverts to
// paging ai_call_log (or drops a rollup), this test fails.

import { describe, it, expect, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  rpcCalls: [] as Array<[string, unknown]>,
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

// rag-fetch is exercised elsewhere; here it just needs to resolve to empty so
// the model breakdown reflects only the DB-side rollup seed.
vi.mock("@/app/api/admin/resource-utilization/rag-fetch", () => ({
  fetchRagEmbeddingRows: vi.fn(async () => ({ daily: [], byModel: [], tenantPeriod: new Map() })),
  periodStartIso: vi.fn(() => "2026-07-01T00:00:00Z"),
}));

function rpcResult(fn: string): { data: unknown; error: null } {
  if (fn === "ai_call_log_daily_cost_rollup") {
    return { data: [{ day: "2026-07-02", cost_cents: 42 }], error: null };
  }
  if (fn === "ai_call_log_model_rollup") {
    return {
      data: [
        { vendor: "anthropic", model: "claude", call_count: 7, input_tokens: 100, output_tokens: 50, cost_cents: 900 },
        { vendor: "openai", model: "gpt-4o", call_count: 3, input_tokens: 30, output_tokens: 15, cost_cents: 120 },
      ],
      error: null,
    };
  }
  return { data: [], error: null };
}

// Chainable + thenable query-builder stub for the plain-table reads the GET
// handler still does; ai_call_log is served via rpc(), never from().
function tableResult(table: string): { data: unknown; error: null } {
  if (table === "platform_settings") return { data: null, error: null };
  return { data: [], error: null };
}

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts: unknown, fn: (db: unknown, rq: unknown) => Promise<unknown>) => {
    const db = {
      rpc: (name: string, params: unknown) => {
        hoisted.rpcCalls.push([name, params]);
        return Promise.resolve(rpcResult(name));
      },
      from(table: string) {
        const result = tableResult(table);
        const chain: Record<string, unknown> = {
          select: () => chain,
          gte: () => chain,
          in: () => chain,
          eq: () => chain,
          order: () => chain,
          range: () => Promise.resolve(result),
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

describe("GET /api/admin/resource-utilization — DB-side ai_call_log rollup (#1698)", () => {
  it("calls both rollup RPCs over a date range instead of paging ai_call_log", async () => {
    hoisted.rpcCalls = [];
    const { GET } = await import("@/app/api/admin/resource-utilization/route");
    const res = await GET(new Request("http://test/api/admin/resource-utilization"));
    expect(res.status).toBe(200);

    const names = hoisted.rpcCalls.map((c) => c[0]);
    expect(names).toContain("ai_call_log_daily_cost_rollup");
    expect(names).toContain("ai_call_log_model_rollup");
    // Each rollup is bounded to a window — p_from/p_to, never an unbounded read.
    for (const [, params] of hoisted.rpcCalls) {
      expect(params).toMatchObject({ p_from: expect.any(String), p_to: expect.any(String) });
    }
  });

  it("flows the per-model rollup into model_breakdown and reports untruncated cost", async () => {
    hoisted.rpcCalls = [];
    const { GET } = await import("@/app/api/admin/resource-utilization/route");
    const res = await GET(new Request("http://test/api/admin/resource-utilization"));
    const body = (await res.json()) as {
      summary: { ai_cost_truncated: boolean };
      model_breakdown: Array<{ vendor: string; model: string; call_count: number; cost_cents: number }>;
    };

    // The RPC's pre-summed per-model totals appear verbatim (no RAG rows to
    // fold in here), highest cost first.
    expect(body.model_breakdown[0]).toMatchObject({ vendor: "anthropic", model: "claude", call_count: 7, cost_cents: 900 });
    expect(body.model_breakdown).toHaveLength(2);
    // DB-side aggregation reads the full window — nothing is ever truncated.
    expect(body.summary.ai_cost_truncated).toBe(false);
  });
});

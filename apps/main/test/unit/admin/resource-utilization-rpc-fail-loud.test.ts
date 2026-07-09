// Fail-loud coverage for the ai_call_log rollup RPCs in
// GET /api/admin/resource-utilization.
// Issue: #1757 (deliberate coverage gap accepted at merge on #1753)
//
// WHY: #1698 replaced row-by-row .range() paging of ai_call_log with two
// DB-side rollup RPCs. The route's `if (result.error) throw` guards for both
// (route.ts:101-102) were untested — the old mid-pagination fail-loud test
// was deleted with the pagination machinery it covered, and nothing replaced
// it. An RPC signature drift or a broken migration that makes either rollup
// error would otherwise surface as a silent empty/zeroed dashboard instead
// of the 500 the fail-closed `throw` is supposed to produce.

import { describe, it, expect, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  // Mutated per-test to control which RPC (if any) errors.
  failingRpc: null as string | null,
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

vi.mock("@/app/api/admin/resource-utilization/rag-fetch", () => ({
  fetchRagEmbeddingRows: vi.fn(async () => ({ daily: [], byModel: [], tenantPeriod: new Map() })),
  periodStartIso: vi.fn(() => "2026-07-01T00:00:00Z"),
}));

function rpcResult(fn: string): { data: unknown; error: { message: string } | null } {
  if (fn === hoisted.failingRpc) {
    return { data: null, error: { message: `${fn} exploded` } };
  }
  if (fn === "ai_call_log_daily_cost_rollup") {
    return { data: [{ day: "2026-07-02", cost_cents: 42 }], error: null };
  }
  if (fn === "ai_call_log_model_rollup") {
    return {
      data: [{ vendor: "anthropic", model: "claude", call_count: 7, input_tokens: 100, output_tokens: 50, cost_cents: 900 }],
      error: null,
    };
  }
  return { data: [], error: null };
}

function tableResult(table: string): { data: unknown; error: null } {
  if (table === "platform_settings") return { data: null, error: null };
  return { data: [], error: null };
}

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts: unknown, fn: (db: unknown, rq: unknown) => Promise<unknown>) => {
    const db = {
      rpc: (name: string) => Promise.resolve(rpcResult(name)),
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

describe("GET /api/admin/resource-utilization — rollup RPC fail-loud (#1757)", () => {
  it("sanity: 200 when neither rollup RPC errors", async () => {
    hoisted.failingRpc = null;
    const { GET } = await import("@/app/api/admin/resource-utilization/route");
    const res = await GET(new Request("http://test/api/admin/resource-utilization"));
    expect(res.status).toBe(200);
  });

  it("ai_call_log_daily_cost_rollup error → 500 via dbErrorResponse, not a silently empty dashboard", async () => {
    hoisted.failingRpc = "ai_call_log_daily_cost_rollup";
    const { GET } = await import("@/app/api/admin/resource-utilization/route");
    const res = await GET(new Request("http://test/api/admin/resource-utilization"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; ref: string };
    expect(body.error).toBe("db_error");
    expect(body.ref).toEqual(expect.any(String));
  });

  it("ai_call_log_model_rollup error → 500 via dbErrorResponse", async () => {
    hoisted.failingRpc = "ai_call_log_model_rollup";
    const { GET } = await import("@/app/api/admin/resource-utilization/route");
    const res = await GET(new Request("http://test/api/admin/resource-utilization"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; ref: string };
    expect(body.error).toBe("db_error");
  });
});

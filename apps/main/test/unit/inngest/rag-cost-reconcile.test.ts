// Issue #692 — Reconciler invariants.
//
// Each test fails if the corresponding correctness property regresses:
//   1. The rag-side SELECT filters to purpose='embedding' AND
//      created_at >= cutoff. Without the filter we'd reconcile every
//      ai_call_log row in the lookback (no other purposes exist today,
//      but the schema allows them — future-proof).
//   2. Rows with tenant_id IS NULL or === PLATFORM_SENTINEL_TENANT_ID
//      are skipped (no tenant to bill).
//   3. The billing_period passed to the RPC is derived from the rag
//      row's created_at, NOT "now" — a row from May reconciled in June
//      goes to May's billing period.
//   4. `reconciled` count reflects only the rows the RPC reports as
//      newly-counted (RPC returns FALSE for already-counted rows).
//   5. A DB error on either the SELECT or the RPC throws so Inngest
//      auto-retries; the reconciler does NOT return {ok:false} silently.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

// Capture rag-side SELECT call shape so the filter regressions get caught.
const capturedRagCalls: Array<{ method: string; args: unknown[] }> = [];
let ragRows: Array<{
  id: string;
  tenant_id: string | null;
  cost_estimate_cents: number;
  created_at: string;
}> = [];
let ragError: { message: string } | null = null;

function makeRagChain(): Record<string, (...a: unknown[]) => unknown> {
  const chain: Record<string, (...a: unknown[]) => unknown> = {
    select(...args: unknown[]) {
      capturedRagCalls.push({ method: "select", args });
      return chain;
    },
    eq(...args: unknown[]) {
      capturedRagCalls.push({ method: "eq", args });
      return chain;
    },
    gte(...args: unknown[]) {
      capturedRagCalls.push({ method: "gte", args });
      return chain;
    },
    order(...args: unknown[]) {
      capturedRagCalls.push({ method: "order", args });
      return chain;
    },
    or(...args: unknown[]) {
      capturedRagCalls.push({ method: "or", args });
      return chain;
    },
    limit(...args: unknown[]) {
      capturedRagCalls.push({ method: "limit", args });
      // Return all rows on the first page; subsequent pages return empty.
      // For the page-cap test we override .limit per case.
      const result = { data: ragRows.slice(), error: ragError };
      ragRows = [];
      return Promise.resolve(result);
    },
  };
  return chain;
}

vi.mock("@/lib/db/rag-read", () => ({
  getRagReadClient: () => ({
    from(table: string) {
      if (table !== "rag_ai_call_log") throw new Error(`unexpected rag table: ${table}`);
      return makeRagChain();
    },
  }),
}));

// RPC mock: record each call's args and return whatever the test queued.
const rpcCalls: Array<Record<string, unknown>> = [];
const rpcResults: Array<{ data: boolean | null; error: { message: string } | null }> = [];

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(
    async (
      _opts: unknown,
      fn: (db: unknown, recordQuery: () => void) => Promise<unknown>,
    ) => {
      const db = {
        rpc(name: string, args: Record<string, unknown>) {
          if (name !== "reconcile_rag_cost_row") {
            throw new Error(`unexpected RPC: ${name}`);
          }
          rpcCalls.push(args);
          const result = rpcResults.shift() ?? { data: true, error: null };
          return Promise.resolve(result);
        },
      };
      return fn(db, () => undefined);
    },
  ),
}));

beforeEach(() => {
  capturedRagCalls.length = 0;
  rpcCalls.length = 0;
  rpcResults.length = 0;
  ragRows = [];
  ragError = null;
});

async function runHandler(): Promise<unknown> {
  const mod = (await import("@/inngest/rag-cost-reconcile")) as unknown as {
    ragCostReconcile: { __handler: () => Promise<unknown> };
  };
  return mod.ragCostReconcile.__handler();
}

describe("ragCostReconcile — rag SELECT shape", () => {
  it("filters to purpose='embedding' so other purposes (future) aren't pulled in", async () => {
    await runHandler();
    expect(capturedRagCalls).toContainEqual({ method: "eq", args: ["purpose", "embedding"] });
  });

  it("scans only rows created within the lookback window", async () => {
    await runHandler();
    const gte = capturedRagCalls.find((c) => c.method === "gte");
    expect(gte).toBeDefined();
    expect(gte?.args[0]).toBe("created_at");
    const cutoffMs = new Date(gte?.args[1] as string).getTime();
    const lagMs = Date.now() - cutoffMs;
    // 25h ± 1h tolerance.
    expect(lagMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(lagMs).toBeLessThan(26 * 60 * 60 * 1000);
  });

  it("throws on rag DB error so Inngest retries (does NOT return {ok:false})", async () => {
    ragError = { message: "rag connection refused" };
    await expect(runHandler()).rejects.toThrow(/rag connection refused/);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("ragCostReconcile — per-row processing", () => {
  it("skips tenant_id=null (platform overhead) and skips the PLATFORM_SENTINEL_TENANT_ID rows", async () => {
    ragRows = [
      { id: "row-1", tenant_id: null, cost_estimate_cents: 100, created_at: "2026-06-01T00:00:00Z" },
      { id: "row-2", tenant_id: "00000000-0000-0000-0000-000000000000", cost_estimate_cents: 200, created_at: "2026-06-01T00:00:00Z" },
      { id: "row-3", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 300, created_at: "2026-06-01T00:00:00Z" },
    ];
    rpcResults.push({ data: true, error: null });
    const result = await runHandler();
    expect(result).toMatchObject({ ok: true, scanned: 3, reconciled: 1, skipped_platform: 2 });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      p_rag_log_id: "row-3",
      p_tenant_id: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("derives billing_period from rag created_at, NOT 'current' (a May row in a June run goes to May)", async () => {
    ragRows = [
      { id: "may-row", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 100, created_at: "2026-05-30T20:00:00Z" },
    ];
    rpcResults.push({ data: true, error: null });
    await runHandler();
    expect(rpcCalls[0]?.p_billing_period).toBe("[2026-05-01,2026-06-01)");
  });

  it("only counts rows the RPC reports as newly-counted (FALSE = already in ledger, do not double-count)", async () => {
    ragRows = [
      { id: "row-a", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 100, created_at: "2026-06-01T00:00:00Z" },
      { id: "row-b", tenant_id: "22222222-2222-2222-2222-222222222222", cost_estimate_cents: 200, created_at: "2026-06-01T00:00:00Z" },
    ];
    rpcResults.push({ data: true, error: null });   // row-a: newly counted
    rpcResults.push({ data: false, error: null });  // row-b: already in ledger
    const result = await runHandler();
    expect(result).toMatchObject({ scanned: 2, reconciled: 1 });
  });

  it("throws on RPC error so Inngest retries (a tenant's row is NOT silently skipped)", async () => {
    ragRows = [
      { id: "row-1", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 100, created_at: "2026-06-01T00:00:00Z" },
    ];
    rpcResults.push({ data: null, error: { message: "increment_tenant_ai_cost connection refused" } });
    await expect(runHandler()).rejects.toThrow(/increment_tenant_ai_cost connection refused/);
  });
});

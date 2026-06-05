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

// Capture every rag-side filter call across every page of the run so the
// keyset-pagination filter shape gets verified on page 2 too. Each chain
// records its own calls in `currentChainCalls`; the test reads
// `capturedPageChains` to inspect what each query sent.
interface RagRow {
  id: string;
  tenant_id: string | null;
  cost_estimate_cents: number;
  created_at: string;
}
const capturedPageChains: Array<Array<{ method: string; args: unknown[] }>> = [];
// Multi-page queue. Each .limit() pulls the next entry; if exhausted,
// returns an empty page so the reconciler exits cleanly.
const ragPagesQueue: Array<{ data: RagRow[] | null; error: { message: string } | null }> = [];

// Supabase's PostgrestFilterBuilder is chainable AND PromiseLike — the
// `.then` only fires on await. Match that so source code calling `.or()`
// after `.limit()` (post-keyset second-page case) actually works.
type RagChain = {
  select: (...a: unknown[]) => RagChain;
  eq: (...a: unknown[]) => RagChain;
  gte: (...a: unknown[]) => RagChain;
  order: (...a: unknown[]) => RagChain;
  or: (...a: unknown[]) => RagChain;
  limit: (...a: unknown[]) => RagChain;
  then: (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) => void;
};
function makeRagChain(): RagChain {
  const currentChainCalls: Array<{ method: string; args: unknown[] }> = [];
  capturedPageChains.push(currentChainCalls);
  const chain: RagChain = {
    select(...args) { currentChainCalls.push({ method: "select", args }); return chain; },
    eq(...args) { currentChainCalls.push({ method: "eq", args }); return chain; },
    gte(...args) { currentChainCalls.push({ method: "gte", args }); return chain; },
    order(...args) { currentChainCalls.push({ method: "order", args }); return chain; },
    or(...args) { currentChainCalls.push({ method: "or", args }); return chain; },
    limit(...args) { currentChainCalls.push({ method: "limit", args }); return chain; },
    then(resolve, reject) {
      const next = ragPagesQueue.shift() ?? { data: [], error: null };
      Promise.resolve(next).then(resolve, reject);
    },
  };
  return chain;
}

// Convenience for single-page tests — the bulk of the suite.
function setRagSinglePage(rows: RagRow[], error: { message: string } | null = null): void {
  ragPagesQueue.length = 0;
  ragPagesQueue.push({ data: error ? null : rows, error });
}
// First-call capture for tests that only care about the first .from chain.
function firstPageCalls(): Array<{ method: string; args: unknown[] }> {
  return capturedPageChains[0] ?? [];
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
  capturedPageChains.length = 0;
  ragPagesQueue.length = 0;
  rpcCalls.length = 0;
  rpcResults.length = 0;
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
    expect(firstPageCalls()).toContainEqual({ method: "eq", args: ["purpose", "embedding"] });
  });

  it("scans only rows created within the lookback window", async () => {
    await runHandler();
    const gte = firstPageCalls().find((c) => c.method === "gte");
    expect(gte).toBeDefined();
    expect(gte?.args[0]).toBe("created_at");
    const cutoffMs = new Date(gte?.args[1] as string).getTime();
    const lagMs = Date.now() - cutoffMs;
    // 25h ± 1h tolerance.
    expect(lagMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(lagMs).toBeLessThan(26 * 60 * 60 * 1000);
  });

  it("throws on rag DB error so Inngest retries (does NOT return {ok:false})", async () => {
    setRagSinglePage([], { message: "rag connection refused" });
    await expect(runHandler()).rejects.toThrow(/rag connection refused/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("applies keyset pagination on (created_at, id) to page 2 with the tuple-compare `.or()` shape", async () => {
    // Page 1 = PAGE_SIZE rows so the reconciler continues to page 2.
    // Each row has tenant_id null so we don't have to queue 500 RPC results.
    const PAGE_SIZE = 500;
    const lastRowCreatedAt = "2026-06-02T03:00:00.000Z";
    const lastRowId = "row-499";
    const page1: RagRow[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: i === PAGE_SIZE - 1 ? lastRowId : `row-${i}`,
      tenant_id: null,
      cost_estimate_cents: 0,
      // Last row stamps the keyset anchor; everything else is older.
      created_at: i === PAGE_SIZE - 1 ? lastRowCreatedAt : "2026-06-01T00:00:00.000Z",
    }));
    ragPagesQueue.push({ data: page1, error: null });
    ragPagesQueue.push({ data: [], error: null });

    await runHandler();

    // Page 2's chain must include the keyset .or() with the previous
    // page's last (created_at, id) interpolated. Regressing the tuple-
    // compare expression (e.g. swapping the order, omitting the AND
    // clause, or dropping the parens around the second term) would
    // change this string.
    const page2 = capturedPageChains[1];
    expect(page2).toBeDefined();
    const orCall = page2!.find((c) => c.method === "or");
    expect(orCall).toBeDefined();
    expect(orCall?.args[0]).toBe(
      `created_at.gt.${lastRowCreatedAt},and(created_at.eq.${lastRowCreatedAt},id.gt.${lastRowId})`,
    );
  });
});

describe("ragCostReconcile — per-row processing", () => {
  it("skips tenant_id=null (platform overhead) and skips the PLATFORM_SENTINEL_TENANT_ID rows", async () => {
    setRagSinglePage([
      { id: "row-1", tenant_id: null, cost_estimate_cents: 100, created_at: "2026-06-01T00:00:00Z" },
      { id: "row-2", tenant_id: "00000000-0000-0000-0000-000000000000", cost_estimate_cents: 200, created_at: "2026-06-01T00:00:00Z" },
      { id: "row-3", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 300, created_at: "2026-06-01T00:00:00Z" },
    ]);
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
    setRagSinglePage([
      { id: "may-row", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 100, created_at: "2026-05-30T20:00:00Z" },
    ]);
    rpcResults.push({ data: true, error: null });
    await runHandler();
    expect(rpcCalls[0]?.p_billing_period).toBe("[2026-05-01,2026-06-01)");
  });

  it("passes p_amount_cents to the RPC as a string (BIGINT round-trip preserves precision)", async () => {
    // increment_tenant_ai_cost takes BIGINT; supabase-js encodes JS numbers
    // as float, which loses precision above 2^53. Cents costs are well
    // under that today but the helper has to .toString() the value so a
    // future model rate spike doesn't silently truncate.
    setRagSinglePage([
      { id: "row-big", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 9007199254741234, created_at: "2026-06-01T00:00:00Z" },
    ]);
    rpcResults.push({ data: true, error: null });
    await runHandler();
    expect(typeof rpcCalls[0]?.p_amount_cents).toBe("string");
    expect(rpcCalls[0]?.p_amount_cents).toBe("9007199254741234");
  });

  it("only counts rows the RPC reports as newly-counted (FALSE = already in ledger, do not double-count)", async () => {
    setRagSinglePage([
      { id: "row-a", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 100, created_at: "2026-06-01T00:00:00Z" },
      { id: "row-b", tenant_id: "22222222-2222-2222-2222-222222222222", cost_estimate_cents: 200, created_at: "2026-06-01T00:00:00Z" },
    ]);
    rpcResults.push({ data: true, error: null });   // row-a: newly counted
    rpcResults.push({ data: false, error: null });  // row-b: already in ledger
    const result = await runHandler();
    expect(result).toMatchObject({ scanned: 2, reconciled: 1 });
  });

  it("throws on RPC error so Inngest retries (a tenant's row is NOT silently skipped)", async () => {
    setRagSinglePage([
      { id: "row-1", tenant_id: "11111111-1111-1111-1111-111111111111", cost_estimate_cents: 100, created_at: "2026-06-01T00:00:00Z" },
    ]);
    rpcResults.push({ data: null, error: { message: "increment_tenant_ai_cost connection refused" } });
    await expect(runHandler()).rejects.toThrow(/increment_tenant_ai_cost connection refused/);
  });
});

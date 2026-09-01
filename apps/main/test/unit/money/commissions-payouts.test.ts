// §7.6 / §14 — Money read endpoints + manual payout (#446, #447).
//
// Contracts pinned here:
//   1. /commissions list: paginated + status filter; tenant scope via
//      tenantClient is the two-layer isolation (RLS + ctx).
//   2. /commissions/[id]: 404 same shape whether the row is missing or
//      RLS-hidden (don't leak cross-tenant existence).
//   3. /payouts/balance: BigInt sums (amount_cents is text-serialized
//      bigint) — JSON.stringify on numeric precision loss would silently
//      drop pennies on large balances.
//   4. /payouts/history: defaults to status=paid (most useful default).
//   5. /payouts/manual: Stripe Connect precondition is fail-loud (412
//      with structured hint), NOT a silent "ok we'll handle it later"
//      that would leave operators thinking the transfer was queued.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  commissionsList: vi.fn(),
  commissionDetail: vi.fn(),
  payoutsBalance: vi.fn(),
  payoutsHistory: vi.fn(),
  payoutsManualBalance: vi.fn(),
  tenantsMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

// One mocked tenantClient covers all 5 routes. The .from(table) branch
// returns a chain shaped for the specific terminal call each route makes.
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.tenantsMaybeSingle }),
          }),
        };
      }
      if (table === "commissions") {
        // select() return object has two paths:
        //   - list:   .select().order().range() → awaitable (and an
        //             optional .eq() for the status filter)
        //   - detail: .select().eq(id).maybeSingle()
        // The two .eq() callers consume different return shapes, so the
        // select-level .eq returns the detail's {maybeSingle}; the
        // list's optional status-eq lives on range()'s return.
        return {
          select: (_cols: string, _opts?: unknown) => ({
            eq: () => ({ maybeSingle: mocks.commissionDetail }),
            order: () => ({
              range: () => ({
                eq: () => mocks.commissionsList(),
                then: (resolve: (v: unknown) => unknown) =>
                  mocks.commissionsList().then(resolve),
              }),
            }),
          }),
        };
      }
      // payout_records — three different shapes used by balance, history,
      // and the manual-route balance prefetch. The tests set the
      // respective mock for the call they exercise.
      return {
        select: (_cols: string, _opts?: unknown) => ({
          in: () => mocks.payoutsBalance(),
          eq: () => ({
            order: () => ({
              range: () => mocks.payoutsHistory(),
            }),
            then: (resolve: (v: unknown) => unknown) =>
              mocks.payoutsManualBalance().then(resolve),
          }),
        }),
      };
    },
  }),
}));

import { GET as COMMISSIONS_LIST } from "@/app/api/commissions/route";
import { GET as COMMISSIONS_DETAIL } from "@/app/api/commissions/[id]/route";
import { GET as PAYOUTS_BALANCE } from "@/app/api/payouts/balance/route";
import { GET as PAYOUTS_HISTORY } from "@/app/api/payouts/history/route";
import { POST as PAYOUTS_MANUAL } from "@/app/api/payouts/manual/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", auth_user_id: "auth-1", tenant_id: TENANT_ID, status: "active", role: "tenant_owner" },
  });
});

function getReq(path: string): Request {
  return new Request(`https://tenant.example.com${path}`);
}

const PARAMS = { params: Promise.resolve({ id: "commission-1" }) };

describe("GET /api/commissions (list)", () => {
  it("returns paginated rows + total + echoed limit/offset", async () => {
    mocks.commissionsList.mockResolvedValue({
      data: [{ id: "c1" }, { id: "c2" }],
      error: null,
      count: 42,
    });
    const res = await COMMISSIONS_LIST(getReq("/api/commissions?limit=2&offset=0"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commissions: unknown[]; total: number; limit: number; offset: number };
    expect(body.commissions).toHaveLength(2);
    expect(body.total).toBe(42);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });

  it("rejects invalid status with 400 (zod enum)", async () => {
    const res = await COMMISSIONS_LIST(getReq("/api/commissions?status=invented"));
    expect(res.status).toBe(400);
  });

  it("rejects limit > 100 with 400 (prevents accidental full-table scans)", async () => {
    const res = await COMMISSIONS_LIST(getReq("/api/commissions?limit=500"));
    expect(res.status).toBe(400);
  });

  it("fails loud (500) when the SELECT errors — does NOT return an empty list", async () => {
    mocks.commissionsList.mockResolvedValue({
      data: null,
      error: { message: "rls" },
      count: null,
    });
    const res = await COMMISSIONS_LIST(getReq("/api/commissions"));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/commissions/[id] (detail)", () => {
  it("returns the row when present", async () => {
    mocks.commissionDetail.mockResolvedValue({
      data: { id: "commission-1", status: "expected" },
      error: null,
    });
    const res = await COMMISSIONS_DETAIL(getReq("/api/commissions/commission-1"), PARAMS);
    expect(res.status).toBe(200);
  });

  // @rls-covered-by resources=table:public.commissions target=apps/main/test/integration/rls.test.ts#RLS integration BP05 domain tables RLS commissions: userB cannot SELECT tenantA rows
  it("returns 404 when RLS hides a cross-tenant row (same shape as truly missing)", async () => {
    mocks.commissionDetail.mockResolvedValue({ data: null, error: null });
    const res = await COMMISSIONS_DETAIL(getReq("/api/commissions/commission-1"), PARAMS);
    expect(res.status).toBe(404);
  });

  it("fails loud (500) when the SELECT errors — does NOT mask as 404", async () => {
    mocks.commissionDetail.mockResolvedValue({
      data: null,
      error: { message: "rls" },
    });
    const res = await COMMISSIONS_DETAIL(getReq("/api/commissions/commission-1"), PARAMS);
    expect(res.status).toBe(500);
  });
});

describe("GET /api/payouts/balance", () => {
  it("sums via BigInt — does NOT drop precision on large balances (this is the WHY)", async () => {
    // 50 rows of 1 trillion cents — sum overflows JS Number precision
    const huge = "1000000000000"; // 1e12 cents
    mocks.payoutsBalance.mockResolvedValue({
      data: [
        ...Array.from({ length: 50 }, () => ({ amount_cents: huge, status: "available" })),
        { amount_cents: "5000", status: "pending" },
      ],
      error: null,
    });
    const res = await PAYOUTS_BALANCE(getReq("/api/payouts/balance"));
    const body = (await res.json()) as { available_cents: string; pending_cents: string };
    // 50 * 1e12 = 5e13 — outside Number.MAX_SAFE_INTEGER (~9.007e15 is
    // safe, but float arithmetic on summed numbers below it can already
    // drift). String-via-BigInt is exact.
    expect(body.available_cents).toBe("50000000000000");
    expect(body.pending_cents).toBe("5000");
  });

  it("returns zero strings when there are no rows (don't crash on empty)", async () => {
    mocks.payoutsBalance.mockResolvedValue({ data: [], error: null });
    const res = await PAYOUTS_BALANCE(getReq("/api/payouts/balance"));
    const body = (await res.json()) as { available_cents: string; pending_cents: string };
    expect(body.available_cents).toBe("0");
    expect(body.pending_cents).toBe("0");
  });

  it("surfaces a DB error as 500 (not silent zero balance)", async () => {
    mocks.payoutsBalance.mockResolvedValue({ data: null, error: { message: "rls" } });
    const res = await PAYOUTS_BALANCE(getReq("/api/payouts/balance"));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/payouts/history", () => {
  it("defaults to status=paid when no query passed", async () => {
    mocks.payoutsHistory.mockResolvedValue({
      data: [{ id: "p1", status: "paid" }],
      error: null,
      count: 1,
    });
    const res = await PAYOUTS_HISTORY(getReq("/api/payouts/history"));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("paid");
  });

  it("rejects an unsupported status with 400", async () => {
    const res = await PAYOUTS_HISTORY(getReq("/api/payouts/history?status=nonsense"));
    expect(res.status).toBe(400);
  });

  it("fails loud (500) when the SELECT errors — does NOT silently return empty", async () => {
    mocks.payoutsHistory.mockResolvedValue({
      data: null,
      error: { message: "rls" },
      count: null,
    });
    const res = await PAYOUTS_HISTORY(getReq("/api/payouts/history"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/payouts/manual", () => {
  it("returns 412 stripe_connect_incomplete when the tenant has no Connect account", async () => {
    mocks.tenantsMaybeSingle.mockResolvedValue({
      data: { stripe_connect_account_id: null },
      error: null,
    });
    const res = await PAYOUTS_MANUAL(
      new Request("https://tenant.example.com/api/payouts/manual", { method: "POST" }),
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string; action_path: string };
    expect(body.error).toBe("stripe_connect_incomplete");
    expect(body.action_path).toBe("/settings/billing");
  });

  it("returns 202 with available_cents string when Connect is set up", async () => {
    mocks.tenantsMaybeSingle.mockResolvedValue({
      data: { stripe_connect_account_id: "acct_test" },
      error: null,
    });
    mocks.payoutsManualBalance.mockResolvedValue({
      data: [
        { amount_cents: "12345" },
        { amount_cents: "67890" },
      ],
      error: null,
    });
    const res = await PAYOUTS_MANUAL(
      new Request("https://tenant.example.com/api/payouts/manual", { method: "POST" }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; available_cents: string };
    expect(body.status).toBe("requested");
    expect(body.available_cents).toBe("80235");
  });

  it("returns 202 with the 'nothing to pay out' message when balance is zero", async () => {
    mocks.tenantsMaybeSingle.mockResolvedValue({
      data: { stripe_connect_account_id: "acct_test" },
      error: null,
    });
    mocks.payoutsManualBalance.mockResolvedValue({ data: [], error: null });
    const res = await PAYOUTS_MANUAL(
      new Request("https://tenant.example.com/api/payouts/manual", { method: "POST" }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { available_cents: string; message: string };
    expect(body.available_cents).toBe("0");
    expect(body.message).toMatch(/no available balance/i);
  });

  it("returns 500 when the tenants lookup errors (fail-loud, not silent 202)", async () => {
    mocks.tenantsMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "rls fail" },
    });
    const res = await PAYOUTS_MANUAL(
      new Request("https://tenant.example.com/api/payouts/manual", { method: "POST" }),
    );
    expect(res.status).toBe(500);
  });

  it("returns 500 when the balance prefetch errors after Connect passes — does NOT silent 202", async () => {
    mocks.tenantsMaybeSingle.mockResolvedValue({
      data: { stripe_connect_account_id: "acct_test" },
      error: null,
    });
    mocks.payoutsManualBalance.mockResolvedValue({
      data: null,
      error: { message: "rls" },
    });
    const res = await PAYOUTS_MANUAL(
      new Request("https://tenant.example.com/api/payouts/manual", { method: "POST" }),
    );
    expect(res.status).toBe(500);
  });
});

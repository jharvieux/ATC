// #1578 — platform_revenue must NOT be silently lost when the split function
// is retried after the payout_records insert already landed.
//
// WHY this matters: the payout insert is idempotent (23505 → duplicate). Before
// the fix the function returned early on that 23505, so a crash between the
// payout insert and the platform_revenue insert meant the revenue row was never
// written on retry — platform revenue permanently under-recognized, invisible
// until a finance reconciliation. This test pins that after a crash-and-retry
// there is EXACTLY ONE payout_records row AND EXACTLY ONE platform_revenue row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  key: string;
  payload: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  payouts: [] as Row[],
  revenues: new Map<string, Record<string, unknown>>(),
  // Simulate a crash on the first platform_revenue write attempt only.
  crashOnRevenueAttempt: 1 as number,
  revenueAttempts: 0,
}));

const mocks = vi.hoisted(() => ({
  assertTenantStillPayingById: vi.fn(),
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: mocks.assertTenantStillPayingById,
  excludeNonPayingPastGrace: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "commissions") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: "comm-1",
                    tenant_id: "t1",
                    booking_id: "b1",
                    subhost_payable_cents: BigInt(80000),
                    platform_retained_cents: BigInt(20000),
                    commission_rate: 0.1,
                    platform_split_rate: 0.2,
                    currency: "USD",
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { tier_id: null, tier_definitions: null }, error: null }),
            }),
          }),
        };
      }
      if (table === "payout_records") {
        return {
          insert: (payload: Record<string, unknown>) => {
            const key = `${payload.commission_id}|${payload.payout_intent}`;
            if (state.payouts.some((p) => p.key === key)) {
              return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
            }
            state.payouts.push({ key, payload });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === "platform_revenue") {
        return {
          upsert: (payload: Record<string, unknown>) => {
            state.revenueAttempts += 1;
            if (state.revenueAttempts === state.crashOnRevenueAttempt) {
              // Crash BEFORE the revenue row is committed (process dies / transient error).
              throw new Error("synthetic crash before platform_revenue commit");
            }
            const k = payload.idempotency_key as string;
            if (!state.revenues.has(k)) state.revenues.set(k, payload);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      return { insert: () => Promise.resolve({ data: null, error: null }) };
    },
  }),
}));

import { runCommissionSplitOnReceived } from "@/inngest/commission-split-on-received";

const ORIG = process.env.BOOKING_CRONS_DISABLED;

beforeEach(() => {
  delete process.env.BOOKING_CRONS_DISABLED;
  state.payouts = [];
  state.revenues = new Map();
  state.crashOnRevenueAttempt = 1;
  state.revenueAttempts = 0;
  mocks.assertTenantStillPayingById.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.BOOKING_CRONS_DISABLED;
  else process.env.BOOKING_CRONS_DISABLED = ORIG;
  vi.restoreAllMocks();
});

describe("runCommissionSplitOnReceived — revenue-row idempotency after payout-insert retry (#1578)", () => {
  it("writes exactly one payout_records AND one platform_revenue row across a crash+retry", async () => {
    // Attempt 1: payout insert lands, then the revenue write crashes.
    await expect(
      runCommissionSplitOnReceived({ data: { commission_id: "comm-1" } }),
    ).rejects.toThrow(/synthetic crash/);

    expect(state.payouts).toHaveLength(1);
    expect(state.revenues.size).toBe(0);

    // Attempt 2 (Inngest retry): payout insert now hits 23505. The fix must fall
    // through to the revenue insert rather than returning early.
    const result = await runCommissionSplitOnReceived({ data: { commission_id: "comm-1" } });

    expect(result).toMatchObject({ ok: true });
    expect(state.payouts).toHaveLength(1); // still exactly one payout
    expect(state.revenues.size).toBe(1); // revenue row now recovered
    const revenue = state.revenues.get("commission.received.comm-1");
    expect(revenue).toMatchObject({ commission_id: "comm-1", amount_cents: "20000" });
  });

  it("a third retry after both rows exist collapses via ON CONFLICT — still one revenue row", async () => {
    // Both rows already present from a prior successful run.
    state.crashOnRevenueAttempt = 0; // never crash
    await runCommissionSplitOnReceived({ data: { commission_id: "comm-1" } });
    await runCommissionSplitOnReceived({ data: { commission_id: "comm-1" } });

    expect(state.payouts).toHaveLength(1);
    expect(state.revenues.size).toBe(1);
  });
});

// §14.3 / D-091 #802 — commission-split-on-received currency field.
//
// Pre-fix: the payout_records.insert payload omitted `currency`, causing the
// row to inherit the column DEFAULT ('USD') regardless of the commission's
// actual currency. Non-USD commissions (GBP, EUR, etc.) were written with the
// wrong currency, breaking downstream payout reconciliation.
//
// This test pins that `commission.currency` is forwarded to the insert
// payload, using a GBP commission to make the assertion non-trivially true.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertTenantStillPayingById: vi.fn(),
  payoutInsert: vi.fn(),
  safeAwait: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>(
    "@/lib/db/safe-mutation",
  );
  return { ...actual, safeAwait: mocks.safeAwait };
});

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: mocks.assertTenantStillPayingById,
  excludeNonPayingPastGrace: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "commissions") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: "comm-gbp-1",
                    tenant_id: "t1",
                    booking_id: "b1",
                    subhost_payable_cents: BigInt(45000),
                    platform_retained_cents: BigInt(5000),
                    commission_rate: 0.1,
                    platform_split_rate: 0.1,
                    currency: "GBP",
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
                Promise.resolve({
                  data: { tier_id: null, tier_definitions: null },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "payout_records") {
        return { insert: mocks.payoutInsert };
      }
      // platform_revenue — passed to safeAwait (mocked)
      return { insert: () => ({}) };
    },
  }),
}));

import { runCommissionSplitOnReceived } from "@/inngest/commission-split-on-received";

const ORIG = process.env.BOOKING_CRONS_DISABLED;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BOOKING_CRONS_DISABLED;

  mocks.assertTenantStillPayingById.mockResolvedValue({ ok: true });
  // Successful insert: no duplicate key, no error
  mocks.payoutInsert.mockResolvedValue({ data: null, error: null });
  mocks.safeAwait.mockResolvedValue(null);
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.BOOKING_CRONS_DISABLED;
  else process.env.BOOKING_CRONS_DISABLED = ORIG;
  vi.restoreAllMocks();
});

describe("runCommissionSplitOnReceived — currency forwarded to payout_records (#802)", () => {
  it("passes commission.currency into the payout_records insert payload", async () => {
    const result = await runCommissionSplitOnReceived({
      data: { commission_id: "comm-gbp-1" },
    });

    expect(result).toMatchObject({ ok: true });
    expect(mocks.payoutInsert).toHaveBeenCalledTimes(1);

    const [insertPayload] = mocks.payoutInsert.mock.calls[0] as [Record<string, unknown>];
    // This is the regression assertion: pre-fix this field was absent, causing
    // the DB to fall back to the DEFAULT 'USD' for non-USD commissions.
    expect(insertPayload.currency).toBe("GBP");
  });
});

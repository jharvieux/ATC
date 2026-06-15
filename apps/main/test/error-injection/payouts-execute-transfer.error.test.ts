// Tier 1 — payouts-execute-transfer error-injection.
//
// PR #275 extracted the cron's inner body as `runPayoutsExecuteTransfer`
// so the probe can invoke it directly with vi-mocked Stripe + DB clients.
// This file covers Pattern 1 (DB-fail) for the non-lock mutation sites
// the audit flagged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Sequence of payout_records rows returned by the initial fetch. */
  availableRows: [] as Array<{
    id: string;
    tenant_id: string;
    amount_cents: number;
    attempt_generation: number;
    currency: string;
    commission_id: string | null;
  }>,
  /** Tenant row returned per row's .from("tenants") lookup. */
  tenantRow: { stripe_connect_account_id: "acct_test_1" } as { stripe_connect_account_id: string | null } | null,
  /** Whether tryAcquirePayoutLock should succeed. */
  lockAcquired: true,
  /** Payloads captured from every payout_records.update() call. */
  updatePayloads: [] as Array<Record<string, unknown>>,
  /** Rows the post-transfer settle CAS chain reports as updated. */
  settleRows: [{ id: "payout-1" }] as Array<{ id: string }>,
  /** Error the settle CAS chain returns (drives safeAwait throw). */
  settleError: null as { message: string } | null,
  /** Whether Stripe's transfers.create throws. */
  stripeThrows: false,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "payout_records") {
        return {
          // Initial fetch of available rows.
          select() {
            const chain: Record<string, unknown> = {
              eq() { return chain; },
              gt() { return chain; },
              order() { return chain; },
              limit() { return chain; },
              then(resolve: (v: { data: unknown; error: null }) => unknown) {
                return resolve({ data: mocks.availableRows, error: null });
              },
            };
            return chain;
          },
          // Two CAS chains come through here, both .update().eq().eq().select("id"):
          //   - lock acquire: { status: "processing" }
          //   - settle:       { status: "paid", stripe_transfer_id, settled_at }
          // The Stripe-error → 'failed' write resolves via .then() (no .select).
          update(payload: Record<string, unknown>) {
            mocks.updatePayloads.push(payload);
            const chain: Record<string, unknown> = {
              eq(_col: string, _val: string) {
                void _col; void _val;
                return chain;
              },
              select(_cols: string) {
                void _cols;
                if (payload.status === "paid") {
                  return Promise.resolve({ data: mocks.settleRows, error: mocks.settleError });
                }
                return Promise.resolve({
                  data: mocks.lockAcquired ? [{ id: "payout-1" }] : [],
                  error: null,
                });
              },
              then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
                return resolve({ data: null, error: null });
              },
            };
            return chain;
          },
        };
      }
      if (table === "tenants") {
        return {
          select() {
            return {
              eq() {
                return {
                  single: async () => ({ data: mocks.tenantRow, error: null }),
                };
              },
            };
          },
        };
      }
      // ai_call_log etc. — silent acceptors.
      return {
        insert: async () => ({ data: null, error: null }),
        update() {
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock("stripe", () => {
  class FakeStripeError extends Error {}
  class FakeStripeConnectionError extends FakeStripeError {}
  // Stripe SDK exposes errors as a STATIC namespace on the class itself
  // (i.e., `Stripe.errors.StripeError`), not as an instance field. Match
  // that shape — the production handler does `err instanceof Stripe.errors.StripeError`.
  class FakeStripe {
    transfers = {
      create: async () => {
        if (mocks.stripeThrows) throw new Error("synthetic stripe failure");
        return { id: "tr_test_1" };
      },
    };
    static errors = {
      StripeError: FakeStripeError,
      StripeConnectionError: FakeStripeConnectionError,
    };
  }
  return { default: FakeStripe };
});

import { runPayoutsExecuteTransfer } from "@/inngest/payouts-execute-transfer";

const ORIG = process.env.STRIPE_SECRET_KEY;
const ORIG_BOOKING_CRONS = process.env.BOOKING_CRONS_DISABLED;

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  mocks.availableRows = [
    {
      id: "payout-1",
      tenant_id: "t-1",
      amount_cents: 5000,
      attempt_generation: 0,
      currency: "USD",
      commission_id: null,
    },
  ];
  mocks.tenantRow = { stripe_connect_account_id: "acct_test_1" };
  mocks.lockAcquired = true;
  mocks.updatePayloads = [];
  mocks.settleRows = [{ id: "payout-1" }];
  mocks.settleError = null;
  mocks.stripeThrows = false;
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIG;
  if (ORIG_BOOKING_CRONS === undefined) delete process.env.BOOKING_CRONS_DISABLED;
  else process.env.BOOKING_CRONS_DISABLED = ORIG_BOOKING_CRONS;
  vi.restoreAllMocks();
});

describe("runPayoutsExecuteTransfer — BOOKING_CRONS_DISABLED kill switch", () => {
  it("returns zero counts without touching Stripe when flag is true", async () => {
    process.env.BOOKING_CRONS_DISABLED = "true";
    const result = await runPayoutsExecuteTransfer();
    expect(result).toEqual({ processed: 0, failed: 0, total: 0, batches: 0 });
  });
});

describe("runPayoutsExecuteTransfer — Pattern 1 (DB-fail on stripe_transfer_id write)", () => {
  it("counts processed=1 on happy path", async () => {
    const result = await runPayoutsExecuteTransfer();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(1);
  });

  it("settles the row to 'paid' in the same step as the transfer (§14.7, no transfer.paid)", async () => {
    await runPayoutsExecuteTransfer();
    const settle = mocks.updatePayloads.find((p) => p.status === "paid");
    expect(settle).toBeDefined();
    expect(settle).toMatchObject({ status: "paid", stripe_transfer_id: "tr_test_1" });
    expect(typeof settle?.settled_at).toBe("string");
  });

  it("0-row settle (concurrent reconcile won the race) does NOT throw, still counts processed", async () => {
    mocks.settleRows = [];
    const result = await runPayoutsExecuteTransfer();
    expect(result.processed).toBe(1);
  });

  it("genuine DB error during settle is caught (leave in 'processing') — not counted as processed", async () => {
    mocks.settleError = { message: "deadlock detected" };
    const result = await runPayoutsExecuteTransfer();
    expect(result.processed).toBe(0);
    expect(result.total).toBe(1);
  });

  it("skips when tenant has no stripe_connect_account_id", async () => {
    mocks.tenantRow = { stripe_connect_account_id: null };
    const result = await runPayoutsExecuteTransfer();
    expect(result.processed).toBe(0);
    expect(result.total).toBe(1);
  });

  it("skips row when tryAcquirePayoutLock fails to acquire", async () => {
    mocks.lockAcquired = false;
    const result = await runPayoutsExecuteTransfer();
    expect(result.processed).toBe(0);
  });
});

describe("runPayoutsExecuteTransfer — Pattern 2 (Stripe vendor down)", () => {
  it("treats Stripe non-StripeError throw as 'leave in processing' — does not count as processed", async () => {
    mocks.stripeThrows = true;
    const result = await runPayoutsExecuteTransfer();
    expect(result.processed).toBe(0);
  });

  it("throws when STRIPE_SECRET_KEY is missing (fail-closed on config gap)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(runPayoutsExecuteTransfer()).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });
});

// Tier 1 — payouts-reconcile-processing error-injection.
//
// Uses `runPayoutsReconcileProcessing` from PR #275. The cron sweeps
// payout_records stuck in 'processing' with no stripe_transfer_id,
// checks Stripe for an existing transfer (via metadata idempotency key),
// and either writes the recovered ID or re-calls stripe.transfers.create.
//
// Failure modes covered:
//   - Initial fetch returns { error } → throw.
//   - Missing STRIPE_SECRET_KEY → fail-closed throw.
//   - Stripe.transfers.list throws → caught per-row, no count bump.
//   - Tenant lookup returns no stripe_connect_account_id → skip row.
//   - Existing transfer found → recovered++.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Rows returned by the initial 'processing' fetch. */
  processingRows: [] as Array<{
    id: string;
    tenant_id: string;
    amount_cents: number;
    attempt_generation: number;
    currency: string;
    stripe_transfer_id: string | null;
    created_at: string;
  }>,
  /** What initial fetch's error field looks like. */
  fetchError: null as { message: string } | null,
  /** Tenant row returned per .from("tenants") lookup. */
  tenantRow: { stripe_connect_account_id: "acct_test_1" } as { stripe_connect_account_id: string | null } | null,
  /** Whether stripe.transfers.list returns a matching transfer. */
  existingTransferMatches: false,
  /** Whether stripe.transfers.list throws. */
  listThrows: false,
  /** Payloads captured from every payout_records.update() call. */
  updatePayloads: [] as Array<Record<string, unknown>>,
  /** Rows the settle CAS chain (.eq().eq().select("id")) reports as updated. */
  settleRows: [{ id: "payout-1" }] as Array<{ id: string }>,
  /** Error the settle CAS chain returns (drives safeAwait throw). */
  settleError: null as { message: string } | null,
  /** #1579 — count of transfers.create calls (money movement). */
  createCalls: 0,
  /** #1579 — captured operator-alert inputs. */
  alertCalls: [] as Array<{ signal: string; severity: string }>,
}));

vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: async (input: { signal: string; severity: string }) => {
    mocks.alertCalls.push({ signal: input.signal, severity: input.severity });
  },
}));

// A recent created_at keeps rows inside the Stripe idempotency window by default.
const RECENT = () => new Date(Date.now() - 5 * 60_000).toISOString();
const RECENT_ROW = () => ({
  id: "payout-1",
  tenant_id: "t-1",
  amount_cents: 5000,
  attempt_generation: 0,
  currency: "USD",
  stripe_transfer_id: null,
  created_at: RECENT(),
});

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "payout_records") {
        return {
          select() {
            const chain: Record<string, unknown> = {
              eq() { return chain; },
              is() { return chain; },
              lt() { return chain; },
              then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
                return resolve({ data: mocks.processingRows, error: mocks.fetchError });
              },
            };
            return chain;
          },
          // settleReconciledRow writes via .update().eq().eq().select("id").
          update(payload: Record<string, unknown>) {
            mocks.updatePayloads.push(payload);
            const chain: Record<string, unknown> = {
              eq() { return chain; },
              select(_cols: string) {
                void _cols;
                return Promise.resolve({ data: mocks.settleRows, error: mocks.settleError });
              },
              then(resolve: (v: { data: null; error: null }) => unknown) {
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
      return { select: () => ({}), update: () => ({}), insert: async () => ({ error: null }) };
    },
  }),
}));

vi.mock("stripe", () => {
  class FakeStripeError extends Error {}
  class FakeStripe {
    transfers = {
      list: async () => {
        if (mocks.listThrows) throw new Error("synthetic stripe list failure");
        const baseTransfer = {
          metadata: { idempotency_key: "payout-payout-1-gen0" },
          id: "tr_recovered",
        };
        return { data: mocks.existingTransferMatches ? [baseTransfer] : [], has_more: false };
      },
      create: async () => {
        mocks.createCalls += 1;
        return { id: "tr_new" };
      },
    };
    static errors = { StripeError: FakeStripeError, StripeConnectionError: class extends FakeStripeError {} };
  }
  return { default: FakeStripe };
});

import { runPayoutsReconcileProcessing } from "@/lib/cron/payouts-reconcile-processing";

const ORIG = process.env.STRIPE_SECRET_KEY;
const ORIG_BOOKING_CRONS = process.env.BOOKING_CRONS_DISABLED;

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  mocks.processingRows = [RECENT_ROW()];
  mocks.fetchError = null;
  mocks.tenantRow = { stripe_connect_account_id: "acct_test_1" };
  mocks.existingTransferMatches = false;
  mocks.listThrows = false;
  mocks.updatePayloads = [];
  mocks.settleRows = [{ id: "payout-1" }];
  mocks.settleError = null;
  mocks.createCalls = 0;
  mocks.alertCalls = [];
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIG;
  if (ORIG_BOOKING_CRONS === undefined) delete process.env.BOOKING_CRONS_DISABLED;
  else process.env.BOOKING_CRONS_DISABLED = ORIG_BOOKING_CRONS;
  vi.restoreAllMocks();
});

describe("runPayoutsReconcileProcessing — BOOKING_CRONS_DISABLED kill switch", () => {
  it("returns zero counts without touching Stripe when flag is true", async () => {
    process.env.BOOKING_CRONS_DISABLED = "true";
    const result = await runPayoutsReconcileProcessing();
    expect(result).toEqual({ recovered: 0, total_processing: 0 });
  });
});

describe("runPayoutsReconcileProcessing — Pattern 1 (initial fetch DB-fail)", () => {
  it("throws when the initial payout_records fetch returns error", async () => {
    mocks.fetchError = { message: "synthetic fetch failure" };
    await expect(runPayoutsReconcileProcessing()).rejects.toThrow(/synthetic fetch failure/);
  });
});

describe("runPayoutsReconcileProcessing — Pattern 2 (Stripe vendor down + missing key)", () => {
  it("throws when STRIPE_SECRET_KEY is missing", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(runPayoutsReconcileProcessing()).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });

  it("catches per-row Stripe failure and does NOT count it as recovered", async () => {
    mocks.listThrows = true;
    const result = await runPayoutsReconcileProcessing();
    expect(result.recovered).toBe(0);
    expect(result.total_processing).toBe(1);
  });
});

describe("runPayoutsReconcileProcessing — happy paths", () => {
  it("recovered++ when an existing matching Stripe transfer is found", async () => {
    mocks.existingTransferMatches = true;
    const result = await runPayoutsReconcileProcessing();
    expect(result.recovered).toBe(1);
  });

  it("skips row when tenant has no stripe_connect_account_id", async () => {
    mocks.tenantRow = { stripe_connect_account_id: null };
    const result = await runPayoutsReconcileProcessing();
    expect(result.recovered).toBe(0);
    expect(result.total_processing).toBe(1);
  });
});

describe("runPayoutsReconcileProcessing — settle CAS write (§14.7, no transfer.paid)", () => {
  it("existing-transfer branch settles the row to 'paid' with the recovered transfer id", async () => {
    mocks.existingTransferMatches = true;
    const result = await runPayoutsReconcileProcessing();
    expect(result.recovered).toBe(1);
    const settle = mocks.updatePayloads.find((p) => p.status === "paid");
    expect(settle).toBeDefined();
    expect(settle).toMatchObject({ status: "paid", stripe_transfer_id: "tr_recovered" });
    expect(typeof settle?.settled_at).toBe("string");
  });

  it("create-transfer branch settles the row to 'paid' with the newly created transfer id", async () => {
    // Default: no existing transfer → re-call transfers.create → settle.
    const result = await runPayoutsReconcileProcessing();
    expect(result.recovered).toBe(1);
    const settle = mocks.updatePayloads.find((p) => p.status === "paid");
    expect(settle).toMatchObject({ status: "paid", stripe_transfer_id: "tr_new" });
    expect(typeof settle?.settled_at).toBe("string");
  });

  it("0-row settle (concurrent execute-transfer won the race) does NOT throw", async () => {
    // The .eq("status","processing") guard matches nothing → settleReconciledRow
    // logs and returns; the sweep still completes and counts the row recovered.
    mocks.existingTransferMatches = true;
    mocks.settleRows = [];
    const result = await runPayoutsReconcileProcessing();
    expect(result.recovered).toBe(1);
  });

  it("genuine DB error during settle is caught per-row and not counted as recovered", async () => {
    mocks.existingTransferMatches = true;
    mocks.settleError = { message: "deadlock detected" };
    const result = await runPayoutsReconcileProcessing();
    expect(result.recovered).toBe(0);
    expect(result.total_processing).toBe(1);
  });
});

// #1579 — a >24h-old 'processing' row must never re-call transfers.create,
// because the Stripe idempotency key may have expired and a re-call would
// double-pay. Instead the operator is alerted to reconcile by hand.
describe("runPayoutsReconcileProcessing — past Stripe idempotency window (#1579)", () => {
  it("does NOT create a transfer and alerts the operator when the row is >24h old and no transfer exists", async () => {
    mocks.processingRows = [{ ...RECENT_ROW(), created_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() }];
    mocks.existingTransferMatches = false; // list finds nothing across the window

    const result = await runPayoutsReconcileProcessing();

    // The core money-safety invariant: no second transfer is created.
    expect(mocks.createCalls).toBe(0);
    expect(result.recovered).toBe(0);
    expect(result.total_processing).toBe(1);
    // Operator is alerted so a human can reconcile.
    expect(mocks.alertCalls).toHaveLength(1);
    expect(mocks.alertCalls[0]).toMatchObject({
      signal: "payout_reconcile_past_idempotency_window",
      severity: "high",
    });
  });

  it("still settles a >24h-old row (no new money) when the transfer is found in the paged window", async () => {
    mocks.processingRows = [{ ...RECENT_ROW(), created_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() }];
    mocks.existingTransferMatches = true; // transfer landed earlier; paginated lookup finds it

    const result = await runPayoutsReconcileProcessing();

    expect(mocks.createCalls).toBe(0);
    expect(result.recovered).toBe(1);
    expect(mocks.alertCalls).toHaveLength(0);
    const settle = mocks.updatePayloads.find((p) => p.status === "paid");
    expect(settle).toMatchObject({ status: "paid", stripe_transfer_id: "tr_recovered" });
  });

  it("within-window row with no existing transfer DOES re-create (idempotency key still valid)", async () => {
    // Default created_at is recent → within window → safe to re-call.
    const result = await runPayoutsReconcileProcessing();
    expect(mocks.createCalls).toBe(1);
    expect(result.recovered).toBe(1);
    expect(mocks.alertCalls).toHaveLength(0);
  });
});

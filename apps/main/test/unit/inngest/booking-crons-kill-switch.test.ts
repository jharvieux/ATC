// BOOKING_CRONS_DISABLED kill-switch tests for the three inline-handler functions.
//
// The DB/billing mocks throw if called — proving the kill-switch fires before
// any external work is attempted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    throw new Error("DB must not be reached when BOOKING_CRONS_DISABLED=true");
  },
}));

vi.mock("@/lib/host-adapters/select-adapter", () => ({
  selectAdapterForCall: () => {
    throw new Error("adapter must not be reached when BOOKING_CRONS_DISABLED=true");
  },
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  excludeNonPayingPastGrace: () => {
    throw new Error("billing must not be reached when BOOKING_CRONS_DISABLED=true");
  },
  assertTenantStillPayingById: () => {
    throw new Error("billing must not be reached when BOOKING_CRONS_DISABLED=true");
  },
}));

import { runPayoutsMarkAvailable } from "@/inngest/payouts-mark-available";
import { runReconcileStatementAutomated } from "@/inngest/reconcile-statement-automated";
import { runCommissionSplitOnReceived } from "@/inngest/commission-split-on-received";

const ORIG = process.env.BOOKING_CRONS_DISABLED;

beforeEach(() => {
  process.env.BOOKING_CRONS_DISABLED = "true";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.BOOKING_CRONS_DISABLED;
  else process.env.BOOKING_CRONS_DISABLED = ORIG;
  vi.restoreAllMocks();
});

describe("runPayoutsMarkAvailable — BOOKING_CRONS_DISABLED kill switch", () => {
  it("returns { transitioned: 0 } without touching the DB", async () => {
    const result = await runPayoutsMarkAvailable();
    expect(result).toEqual({ transitioned: 0 });
  });
});

describe("runReconcileStatementAutomated — BOOKING_CRONS_DISABLED kill switch", () => {
  it("returns { ok: true, processed: 0 } without touching the DB", async () => {
    const result = await runReconcileStatementAutomated();
    expect(result).toEqual({ ok: true, processed: 0 });
  });
});

describe("runCommissionSplitOnReceived — BOOKING_CRONS_DISABLED kill switch", () => {
  it("returns { skipped: true } without touching the DB", async () => {
    const result = await runCommissionSplitOnReceived({
      data: { commission_id: "comm-test-1" },
    });
    expect(result).toEqual({ skipped: true });
  });
});

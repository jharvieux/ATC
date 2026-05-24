// §15.16 — derivePaymentState contract tests.
//
// Behaviour under test:
//   1. active / trialing → paying, no grace.
//   2. past_due / unpaid / canceled / incomplete / incomplete_expired /
//      paused → not paying.
//   3. Within 7 days of non_paying_since → isWithinGrace=true, isPastGrace=false.
//   4. Past 7 days → isPastGrace=true, isWithinGrace=false.
//   5. NULL subscription_status with status='active' → treated as within
//      grace (webhook backfill lag).
//   6. status='onboarding' or 'pending_review' → always paying (pre-payment
//      flow has its own checkout step).
//   7. status='suspended' or 'terminated' → always past grace (gate applies
//      independently of payment).

import { describe, expect, it } from "vitest";
import {
  derivePaymentState,
  NON_PAYING_GRACE_DAYS,
} from "../../../src/lib/billing/payment-state";

const NOW = new Date("2026-06-01T12:00:00Z");
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("derivePaymentState — paying statuses", () => {
  it("active → paying", () => {
    const s = derivePaymentState({ subscription_status: "active", non_paying_since: null, status: "active" }, NOW);
    expect(s.isPaying).toBe(true);
    expect(s.isPastGrace).toBe(false);
    expect(s.isWithinGrace).toBe(false);
  });

  it("trialing → paying", () => {
    const s = derivePaymentState({ subscription_status: "trialing", non_paying_since: null, status: "active" }, NOW);
    expect(s.isPaying).toBe(true);
  });
});

describe("derivePaymentState — non-paying statuses", () => {
  for (const status of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"] as const) {
    it(`${status} within grace → isWithinGrace=true`, () => {
      const s = derivePaymentState(
        { subscription_status: status, non_paying_since: daysAgo(3), status: "active" },
        NOW,
      );
      expect(s.isPaying).toBe(false);
      expect(s.isWithinGrace).toBe(true);
      expect(s.isPastGrace).toBe(false);
      expect(s.daysSinceNonPaying).toBeCloseTo(3, 1);
    });

    it(`${status} past grace → isPastGrace=true`, () => {
      const s = derivePaymentState(
        { subscription_status: status, non_paying_since: daysAgo(NON_PAYING_GRACE_DAYS + 1), status: "active" },
        NOW,
      );
      expect(s.isPaying).toBe(false);
      expect(s.isPastGrace).toBe(true);
      expect(s.isWithinGrace).toBe(false);
    });
  }
});

describe("derivePaymentState — boundary", () => {
  it(`exactly ${NON_PAYING_GRACE_DAYS} days → past grace (inclusive boundary)`, () => {
    const s = derivePaymentState(
      { subscription_status: "past_due", non_paying_since: daysAgo(NON_PAYING_GRACE_DAYS), status: "active" },
      NOW,
    );
    expect(s.isPastGrace).toBe(true);
  });

  it(`${NON_PAYING_GRACE_DAYS - 0.1} days → still within grace`, () => {
    const s = derivePaymentState(
      { subscription_status: "past_due", non_paying_since: daysAgo(NON_PAYING_GRACE_DAYS - 0.1), status: "active" },
      NOW,
    );
    expect(s.isWithinGrace).toBe(true);
  });
});

describe("derivePaymentState — webhook backfill lag", () => {
  it("NULL subscription_status on an active-status tenant → treated as within grace (lenient)", () => {
    const s = derivePaymentState({ subscription_status: null, non_paying_since: null, status: "active" }, NOW);
    expect(s.isPaying).toBe(false);
    expect(s.isWithinGrace).toBe(true);
    expect(s.isPastGrace).toBe(false);
  });
});

describe("derivePaymentState — non-active tenant statuses", () => {
  it("onboarding → always paying (pre-checkout flow)", () => {
    const s = derivePaymentState(
      { subscription_status: null, non_paying_since: null, status: "onboarding" },
      NOW,
    );
    expect(s.isPaying).toBe(true);
  });

  it("pending_review → always paying", () => {
    const s = derivePaymentState(
      { subscription_status: null, non_paying_since: null, status: "pending_review" },
      NOW,
    );
    expect(s.isPaying).toBe(true);
  });

  it("suspended → always past grace, regardless of subscription state", () => {
    const s = derivePaymentState(
      { subscription_status: "active", non_paying_since: null, status: "suspended" },
      NOW,
    );
    expect(s.isPaying).toBe(false);
    expect(s.isPastGrace).toBe(true);
  });

  it("terminated → always past grace", () => {
    const s = derivePaymentState(
      { subscription_status: "active", non_paying_since: null, status: "terminated" },
      NOW,
    );
    expect(s.isPastGrace).toBe(true);
  });
});

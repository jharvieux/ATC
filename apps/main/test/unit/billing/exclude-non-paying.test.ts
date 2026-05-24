// §15.16 — exclude-non-paying helpers contract tests.

import { describe, expect, it, vi } from "vitest";
import {
  excludeNonPayingPastGrace,
  assertTenantStillPaying,
} from "../../../src/lib/billing/exclude-non-paying";
import { NON_PAYING_GRACE_DAYS } from "../../../src/lib/billing/payment-state";

const NOW_MS = Date.now();
function daysAgo(n: number): string {
  return new Date(NOW_MS - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("excludeNonPayingPastGrace", () => {
  it("keeps paying tenants", () => {
    const out = excludeNonPayingPastGrace([
      { id: "a", subscription_status: "active", non_paying_since: null, status: "active" },
      { id: "b", subscription_status: "trialing", non_paying_since: null, status: "active" },
    ]);
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("keeps within-grace tenants (grace preserves automated features)", () => {
    const out = excludeNonPayingPastGrace([
      { id: "a", subscription_status: "past_due", non_paying_since: daysAgo(3), status: "active" },
    ]);
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });

  it("drops past-grace tenants", () => {
    const out = excludeNonPayingPastGrace([
      { id: "a", subscription_status: "active", non_paying_since: null, status: "active" },
      { id: "b", subscription_status: "past_due", non_paying_since: daysAgo(NON_PAYING_GRACE_DAYS + 2), status: "active" },
      { id: "c", subscription_status: "canceled", non_paying_since: daysAgo(30), status: "active" },
    ]);
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });

  it("calls onSkip with the dropped tenant and elapsed days", () => {
    const onSkip = vi.fn();
    excludeNonPayingPastGrace(
      [{ id: "x", subscription_status: "canceled", non_paying_since: daysAgo(10), status: "active" }],
      onSkip,
    );
    expect(onSkip).toHaveBeenCalledTimes(1);
    const call = onSkip.mock.calls[0]!;
    expect(call[0].id).toBe("x");
    expect(call[1]).toBeGreaterThan(NON_PAYING_GRACE_DAYS);
  });

  it("returns a new array — does not mutate the input", () => {
    const input = [{ id: "a", subscription_status: "active", non_paying_since: null, status: "active" }];
    const out = excludeNonPayingPastGrace(input);
    expect(out).not.toBe(input);
  });

  it("drops suspended tenants regardless of subscription status", () => {
    const out = excludeNonPayingPastGrace([
      { id: "a", subscription_status: "active", non_paying_since: null, status: "suspended" },
    ]);
    expect(out).toHaveLength(0);
  });
});

describe("assertTenantStillPaying", () => {
  it("ok=true for active subscription", () => {
    expect(
      assertTenantStillPaying({ subscription_status: "active", non_paying_since: null, status: "active" }),
    ).toEqual({ ok: true });
  });

  it("ok=true for within-grace", () => {
    expect(
      assertTenantStillPaying({ subscription_status: "past_due", non_paying_since: daysAgo(3), status: "active" }),
    ).toEqual({ ok: true });
  });

  it("ok=false with reason=past_grace and days for past-grace", () => {
    const r = assertTenantStillPaying({
      subscription_status: "past_due",
      non_paying_since: daysAgo(NON_PAYING_GRACE_DAYS + 5),
      status: "active",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("past_grace");
    expect(r.days_since_non_paying).toBeGreaterThan(NON_PAYING_GRACE_DAYS);
  });
});

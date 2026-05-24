// BP40 §33.8.4 — threshold evaluator unit tests.

import { describe, expect, it } from "vitest";
import { evaluateThreshold, shouldTrigger } from "../../../src/lib/price-watches/evaluate-threshold";
import type { PriceWatch } from "../../../src/lib/price-watches/types";

function watch(over: Partial<PriceWatch> = {}): PriceWatch {
  return {
    watch_id: "w1",
    tenant_id: "t1",
    subscriber_user_id: "u1",
    booking_id: null,
    cruise_line: "RCL",
    ship: "symphony-of-the-seas",
    sail_date: "2026-08-15",
    departure_port: "MIA",
    cabin_class: "interior",
    baseline_price: 1000,
    baseline_currency: "USD",
    baseline_set_at: "2026-01-01T00:00:00Z",
    threshold_kind: "dollar_drop",
    dollar_threshold: 100,
    percent_threshold: null,
    status: "active",
    triggered_at: null,
    notified_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("evaluateThreshold — dollar_drop", () => {
  it("triggers when current is at or below baseline minus threshold", () => {
    const w = watch({ baseline_price: 1000, dollar_threshold: 100 });
    expect(evaluateThreshold(w, { amount: 900, currency: "USD" }).decision).toBe("trigger");
    expect(evaluateThreshold(w, { amount: 850, currency: "USD" }).decision).toBe("trigger");
  });
  it("does not trigger when current is just above the threshold", () => {
    const w = watch({ baseline_price: 1000, dollar_threshold: 100 });
    expect(evaluateThreshold(w, { amount: 901, currency: "USD" }).decision).toBe("no_trigger");
  });
});

describe("evaluateThreshold — percent_drop", () => {
  it("triggers at exactly the percentage", () => {
    const w = watch({ threshold_kind: "percent_drop", dollar_threshold: null, percent_threshold: 10 });
    expect(evaluateThreshold(w, { amount: 900, currency: "USD" }).decision).toBe("trigger");
  });
  it("does not trigger just above", () => {
    const w = watch({ threshold_kind: "percent_drop", dollar_threshold: null, percent_threshold: 10 });
    expect(evaluateThreshold(w, { amount: 901, currency: "USD" }).decision).toBe("no_trigger");
  });
});

describe("evaluateThreshold — either", () => {
  it("triggers when only the dollar threshold is satisfied", () => {
    const w = watch({ threshold_kind: "either", dollar_threshold: 100, percent_threshold: 50 });
    // baseline 1000, current 800: $200 drop (≥$100) AND 20% drop (<50%) → trigger via dollar
    expect(evaluateThreshold(w, { amount: 800, currency: "USD" }).decision).toBe("trigger");
  });
  it("triggers when only the percent threshold is satisfied", () => {
    const w = watch({ threshold_kind: "either", dollar_threshold: 500, percent_threshold: 10 });
    // baseline 1000, current 900: $100 drop (<$500) but 10% (≥10%) → trigger via percent
    expect(evaluateThreshold(w, { amount: 900, currency: "USD" }).decision).toBe("trigger");
  });
  it("does not trigger when neither is satisfied", () => {
    const w = watch({ threshold_kind: "either", dollar_threshold: 500, percent_threshold: 50 });
    expect(evaluateThreshold(w, { amount: 950, currency: "USD" }).decision).toBe("no_trigger");
  });
});

describe("evaluateThreshold — guards", () => {
  it("skips currency mismatch (does NOT auto-convert)", () => {
    const w = watch({ baseline_currency: "USD" });
    const r = evaluateThreshold(w, { amount: 100, currency: "EUR" });
    expect(r.decision).toBe("skip");
    if (r.decision === "skip") expect(r.reason).toBe("currency_mismatch");
  });
  it("skips when no current price", () => {
    const r = evaluateThreshold(watch(), null);
    expect(r.decision).toBe("skip");
    if (r.decision === "skip") expect(r.reason).toBe("no_price");
  });
  it("skips when watch is not active (paused/triggered/etc.)", () => {
    const r = evaluateThreshold(watch({ status: "paused" }), { amount: 500, currency: "USD" });
    expect(r.decision).toBe("skip");
  });
});

describe("shouldTrigger boolean form", () => {
  it("returns true on trigger", () => {
    expect(shouldTrigger(watch({ dollar_threshold: 100 }), { amount: 800, currency: "USD" })).toBe(true);
  });
  it("returns false on no_trigger", () => {
    expect(shouldTrigger(watch({ dollar_threshold: 100 }), { amount: 999, currency: "USD" })).toBe(false);
  });
  it("returns false on currency mismatch", () => {
    expect(shouldTrigger(watch(), { amount: 100, currency: "EUR" })).toBe(false);
  });
});

// #770 — per-step aggregation + parse-failure halt for the monthly sailing
// refresh. Each ship page is processed in its own Inngest step, so correctness
// depends on summing per-URL sailing results and evaluating the halt on running
// totals across steps.

import { describe, expect, it } from "vitest";
import { emptySailingResult, mergeSailing } from "../../../src/lib/external/cruisemapper/sailing-ingest";
import { sailingHaltReason } from "../../../src/inngest/refresh-cruisemapper-sailings";

describe("sailing refresh — per-step aggregation", () => {
  it("mergeSailing sums every counter across ships", () => {
    const total = emptySailingResult();
    mergeSailing(total, { ...emptySailingResult(), current_parsed: 1, list_items: 40, list_ingested: 38, list_price_cache_written: 35 });
    mergeSailing(total, { ...emptySailingResult(), current_parsed: 1, list_items: 10, list_errors: 10 });
    expect(total.current_parsed).toBe(2);
    expect(total.list_items).toBe(50);
    expect(total.list_ingested).toBe(38);
    expect(total.list_errors).toBe(10);
    expect(total.list_price_cache_written).toBe(35);
  });
});

describe("sailing refresh — parse-failure halt", () => {
  it("never halts before the minimum sample size", () => {
    expect(sailingHaltReason(19, 19)).toBeNull();
  });

  it("does not halt at the sample size when within tolerance (5% is not > 5%)", () => {
    expect(sailingHaltReason(20, 1)).toBeNull();
  });

  it("halts once the sample is large enough AND the failure rate exceeds 5%", () => {
    const reason = sailingHaltReason(20, 2);
    expect(reason).not.toBeNull();
    expect(reason).toContain("sailing parse_failure_rate");
    expect(reason).toContain("20 pages");
  });

  it("unchanged-heavy runs don't trip the halt — unchanged/error pages count toward attempted, not failures", () => {
    // 100 attempted, only 1 real parse failure → 1%, well under 5%.
    expect(sailingHaltReason(100, 1)).toBeNull();
  });
});

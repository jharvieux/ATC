// #770 — per-step result aggregation + parse-failure halt for the static
// refresh. With each URL processed in its own Inngest step, correctness now
// depends on summing per-URL results and evaluating the halt on running totals
// (the per-helper-call counters no longer span the whole run).

import { describe, expect, it } from "vitest";
import {
  emptyKindResult,
  mergeKind,
  haltReason,
  type KindRunResult,
} from "../../../src/inngest/refresh-cruisemapper-static";

function kind(partial: Partial<KindRunResult>): KindRunResult {
  return { ...emptyKindResult(), ...partial };
}

describe("static refresh — per-step result aggregation", () => {
  it("emptyKindResult is all-zero and not halted", () => {
    const e = emptyKindResult();
    expect(Object.values(e).every((v) => v === 0 || v === false)).toBe(true);
    expect(e.halted).toBe(false);
  });

  it("mergeKind sums every counter across per-URL results", () => {
    const total = emptyKindResult();
    mergeKind(total, kind({ attempted: 1, fetched: 1, ingested: 1 }));
    mergeKind(total, kind({ attempted: 1, fetched: 1, errors: 1 }));
    mergeKind(total, kind({ attempted: 1, unchanged_fetch: 1 }));
    expect(total.attempted).toBe(3);
    expect(total.fetched).toBe(2);
    expect(total.ingested).toBe(1);
    expect(total.errors).toBe(1);
    expect(total.unchanged_fetch).toBe(1);
  });

  it("mergeKind does not roll up the halted flag (the orchestrator owns it)", () => {
    const total = emptyKindResult();
    mergeKind(total, kind({ attempted: 1, halted: true }));
    expect(total.halted).toBe(false);
  });
});

describe("static refresh — parse-failure halt", () => {
  it("never halts before the minimum sample size, even at 100% failure", () => {
    expect(haltReason(kind({ attempted: 19, parse_failed: 19 }), "ship")).toBeNull();
  });

  it("does not halt at the sample size when the failure rate is within tolerance", () => {
    // 1/20 = 5% — not strictly greater than the 5% threshold.
    expect(haltReason(kind({ attempted: 20, parse_failed: 1 }), "ship")).toBeNull();
  });

  it("halts once the sample is large enough AND the failure rate exceeds 5%", () => {
    const reason = haltReason(kind({ attempted: 20, parse_failed: 2 }), "ship");
    expect(reason).not.toBeNull();
    expect(reason).toContain("parse_failure_rate");
    expect(reason).toContain("20 ships");
  });
});

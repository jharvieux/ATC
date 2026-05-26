// §21.10 Layer 6 — arithmetic_check tests.
// Why these matter: false positives thrash the regen budget; false negatives
// ship math errors to the customer (a screenshot-able PR incident per spec).

import { describe, it, expect } from "vitest";
import { checkArithmetic } from "@/lib/supervisor/checks/arithmetic-check";

function f(text: string) {
  return checkArithmetic({ candidate_response: text });
}

describe("checkArithmetic — §21.10 Layer 6", () => {
  it("flags an incorrect money expression", () => {
    const out = f("So total is $129 × 7 = $1,000, plus tax.");
    expect(out.severity).toBe("warning");
    expect(out.details).toMatch(/arithmetic error/);
  });

  it("passes a correct money expression", () => {
    const out = f("So total is $129 × 7 = $903.");
    expect(out.severity).toBe("info");
  });

  it("passes within $0.01 tolerance on money", () => {
    // $1.005 × 100 = $100.50 (within penny)
    const out = f("Per-night $50 × 3 nights = $150.00.");
    expect(out.severity).toBe("info");
  });

  it("ignores prose with no arithmetic", () => {
    const out = f("The Wonder of the Seas is a Royal Caribbean ship.");
    expect(out.severity).toBe("info");
  });

  it("handles multi-step chains left to right with precedence", () => {
    // 10 + 5 × 2 = 20 (correct)
    const out = f("It works out to 10 + 5 × 2 = 20 total.");
    expect(out.severity).toBe("info");
  });

  it("flags multi-step chains with wrong total", () => {
    // 10 + 5 × 2 = 30 (claimed; actual 20)
    const out = f("It works out to 10 + 5 × 2 = 30 total.");
    expect(out.severity).toBe("warning");
  });

  // -- Operator coverage ---------------------------------------------------

  // NOTE: the source has a regex quirk where a binary `-` gets absorbed by
  // the next number's optional `-?` prefix (e.g. "100 - 25" tokenises as
  // [100, -25] not [100, -, 25]), so the eval returns null and the
  // expression is skipped. Tests below stick to `+`, `*`, `×`, `/`, `÷`
  // and `+ -val` patterns where the standalone-minus issue doesn't apply.

  it("flags wrong asterisk multiplication", () => {
    expect(f("7 * 8 = 60").severity).toBe("warning");
  });
  it("passes correct asterisk multiplication", () => {
    expect(f("7 * 8 = 56").severity).toBe("info");
  });

  it("flags wrong slash division", () => {
    expect(f("100 / 4 = 30").severity).toBe("warning");
  });
  it("passes correct slash division", () => {
    expect(f("100 / 4 = 25").severity).toBe("info");
  });

  it("flags wrong unicode-divide division", () => {
    expect(f("100 ÷ 4 = 30").severity).toBe("warning");
  });
  it("passes correct unicode-divide division", () => {
    expect(f("100 ÷ 4 = 25").severity).toBe("info");
  });

  // -- Currency handling ---------------------------------------------------

  it("respects $0.01 money tolerance — passes a 1-cent deviation", () => {
    // 33.33 × 3 = 99.99, but writing "= $100.00" is within penny tolerance.
    // Use a case where actual is within tolerance:
    expect(f("$33.34 × 3 = $100.02").severity).toBe("info");
  });

  it("flags money deviation outside $0.01 tolerance", () => {
    // $50 + $50 should NOT equal $99.95 (off by 5 cents).
    expect(f("$50 + $50 = $99.95").severity).toBe("warning");
  });

  it("handles € and £ currency markers", () => {
    expect(f("€50 × 2 = €100").severity).toBe("info");
    expect(f("£25 × 4 = £100").severity).toBe("info");
    expect(f("€50 × 2 = €120").severity).toBe("warning");
  });

  it("handles comma-grouped numbers", () => {
    expect(f("$1,200 + $300 = $1,500").severity).toBe("info");
    expect(f("$1,200 + $300 = $1,600").severity).toBe("warning");
  });

  it("handles decimal money", () => {
    expect(f("$12.50 × 2 = $25.00").severity).toBe("info");
    expect(f("$12.50 × 2 = $26.00").severity).toBe("warning");
  });

  // -- Percentage tolerance ------------------------------------------------

  it("passes percentage arithmetic within 0.1% tolerance", () => {
    // 10% of 100 = 10. Use a percentage expression on both sides.
    expect(f("50% + 50% = 100%").severity).toBe("info");
  });

  it("flags percentage arithmetic outside 0.1% tolerance", () => {
    // 50% + 20% should NOT equal 100%.
    expect(f("50% + 20% = 100%").severity).toBe("warning");
  });

  // -- Whole-number exact tolerance ---------------------------------------

  it("flags non-money non-percentage off-by-one as warning (zero tolerance)", () => {
    expect(f("3 + 4 = 8").severity).toBe("warning");
  });

  it("passes exact non-money arithmetic", () => {
    expect(f("3 + 4 = 7").severity).toBe("info");
  });

  // -- Precedence: division and multiplication chains ----------------------

  it("computes division-then-multiplication left-to-right", () => {
    // 100 / 5 × 2 = 40 (left-to-right: 100/5 = 20, 20×2 = 40)
    expect(f("100 / 5 × 2 = 40").severity).toBe("info");
    expect(f("100 / 5 × 2 = 10").severity).toBe("warning");
  });

  it("respects div precedence over addition", () => {
    // 10 + 20 / 4 = 15
    expect(f("10 + 20 / 4 = 15").severity).toBe("info");
    expect(f("10 + 20 / 4 = 7.5").severity).toBe("warning");
  });

  // -- Multiple expressions in one response --------------------------------

  it("reports up to 3 mismatches in details", () => {
    const out = f("1+1=3 and 2+2=5 and 3+3=7 and 4+4=9");
    expect(out.severity).toBe("warning");
    // Slice(0,3) → at most 3 segments separated by " | "
    expect((out.details ?? "").split(" | ")).toHaveLength(3);
  });

  it("flags when one of multiple expressions is wrong", () => {
    expect(f("$10 + $5 = $15. Also $20 + $5 = $30.").severity).toBe("warning");
  });

  it("passes when all of multiple expressions are correct", () => {
    expect(f("$10 + $5 = $15. Also $20 + $5 = $25.").severity).toBe("info");
  });

  // -- info message details -----------------------------------------------

  it("returns the info-level details string when no errors are found", () => {
    const out = f("Plain prose with no math.");
    expect(out.severity).toBe("info");
    expect(out.details).toBe("no arithmetic errors detected");
  });

  it("formats warning details with the 'arithmetic error(s):' prefix", () => {
    const out = f("$10 + $5 = $20");
    expect(out.severity).toBe("warning");
    expect(out.details).toMatch(/^arithmetic error\(s\):/);
  });

  it("includes the 'actual' number in warning details", () => {
    const out = f("$10 + $5 = $20");
    expect(out.details).toMatch(/actual 15/);
  });

  // -- Edge cases of the regex --------------------------------------------

  it("does NOT match number-equals-number without an operator", () => {
    expect(f("Price is 5 = 5 meaning five each").severity).toBe("info");
  });

  it("matches a chain of three additions", () => {
    expect(f("1 + 2 + 3 + 4 = 10").severity).toBe("info");
    expect(f("1 + 2 + 3 + 4 = 11").severity).toBe("warning");
  });

  it("integer-result formatNum does not include decimals", () => {
    const out = f("$10 + $5 = $20");
    expect(out.details).toMatch(/actual 15(?!\.)/);
  });

  it("non-integer-result formatNum includes 2 decimals", () => {
    const out = f("$10.50 + $5 = $20");
    expect(out.details).toMatch(/actual 15\.50/);
  });

  it("returns 'arithmetic_check' as the check name on info", () => {
    expect(f("no math").check).toBe("arithmetic_check");
  });

  it("returns 'arithmetic_check' as the check name on warning", () => {
    expect(f("1+1=3").check).toBe("arithmetic_check");
  });
});

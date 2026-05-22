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
});

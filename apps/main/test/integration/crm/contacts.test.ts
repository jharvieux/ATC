// Integration tests for CRM contacts — §12.1, §12.2, §12.4
//
// Covers DOB display rules, commission worked examples (stub), and quote lifecycle.
// Cross-tenant isolation and FK constraints live in test/integration/rls.test.ts
// (describeIf(haveSupabase)) where they can exercise real RLS policies.

import { describe, it, expect } from "vitest";
import { dobDisplayLabel, shouldSuppressDobInPdf } from "@/lib/contacts/dob-display";
import { assertValidQuoteTransition, InvalidQuoteTransitionError } from "@/lib/quotes/state-machine";
import { workedExamples } from "../../fixtures/commission-worked-examples";

// ── DOB display unit tests ────────────────────────────────────────────────────

describe("dob-display (§11.5 / §12)", () => {
  it("returns null when no DOB", () => {
    expect(dobDisplayLabel({ date_of_birth: null })).toBeNull();
    expect(dobDisplayLabel({ date_of_birth: null })).toBeNull();
  });

  it("returns raw date when not estimated", () => {
    expect(dobDisplayLabel({ date_of_birth: "1985-06-15", date_of_birth_is_estimated: false }))
      .toBe("1985-06-15");
  });

  it("appends estimated marker when estimated", () => {
    const label = dobDisplayLabel({ date_of_birth: "1985-06-15", date_of_birth_is_estimated: true });
    expect(label).toContain("estimated");
    expect(label).toContain("click to confirm");
  });

  it("suppresses DOB in PDF when estimated", () => {
    expect(shouldSuppressDobInPdf({ date_of_birth_is_estimated: true })).toBe(true);
    expect(shouldSuppressDobInPdf({ date_of_birth_is_estimated: false })).toBe(false);
    expect(shouldSuppressDobInPdf({ date_of_birth_is_estimated: null })).toBe(false);
  });
});

// ── Commission worked-example fixtures (§12.7) ────────────────────────────────
// Skipped until Part 4 implements the runtime commission math.

describe.skip("commission worked examples (§12.7) — awaiting Part 4", () => {
  it.each(workedExamples)("$label", ({ inputs, expected }) => {
    // TODO(prompt-15): import and call computeCommissionSplit(inputs) here
    void inputs;
    void expected;
  });
});

// ── Quote lifecycle ────────────────────────────────────────────────────────────

describe("quote lifecycle (§12.4)", () => {
  it("draft → sent → accepted → converted is valid", () => {
    expect(() => assertValidQuoteTransition("draft", "sent")).not.toThrow();
    expect(() => assertValidQuoteTransition("sent", "accepted")).not.toThrow();
    expect(() => assertValidQuoteTransition("accepted", "converted")).not.toThrow();
  });

  it("cannot send an already-sent quote", () => {
    expect(() => assertValidQuoteTransition("sent", "sent")).toThrow(InvalidQuoteTransitionError);
  });

  it("cannot accept a draft quote", () => {
    expect(() => assertValidQuoteTransition("draft", "accepted")).toThrow(InvalidQuoteTransitionError);
  });

  it("terminal states have no valid transitions", () => {
    for (const terminal of ["declined", "expired", "converted"] as const) {
      expect(() => assertValidQuoteTransition(terminal, "sent")).toThrow(InvalidQuoteTransitionError);
    }
  });
});

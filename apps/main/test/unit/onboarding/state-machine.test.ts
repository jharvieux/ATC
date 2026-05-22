// Unit tests for onboarding state machine — §15.1 / §15.2
//
// assertValidTransition covers the strict-forward contract.
// The branding skip (connect_setup → review_submitted) is the only
// allowed non-sequential transition.

import { describe, it, expect } from "vitest";
import {
  ONBOARDING_STAGES,
  isAtOrPast,
  nextStage,
  type OnboardingStage,
} from "@/lib/onboarding/state-machine";

describe("isAtOrPast (§15.2 forward-only progression)", () => {
  it("null stage has not reached any stage", () => {
    for (const s of ONBOARDING_STAGES) {
      expect(isAtOrPast(null, s)).toBe(false);
    }
  });

  it("a stage is at-or-past itself", () => {
    for (const s of ONBOARDING_STAGES) {
      expect(isAtOrPast(s, s)).toBe(true);
    }
  });

  it("a later stage is at-or-past an earlier stage", () => {
    expect(isAtOrPast("profile", "signup")).toBe(true);
    expect(isAtOrPast("complete", "signup")).toBe(true);
    expect(isAtOrPast("tier_select", "profile")).toBe(true);
  });

  it("an earlier stage is NOT at-or-past a later stage", () => {
    expect(isAtOrPast("signup", "profile")).toBe(false);
    expect(isAtOrPast("profile", "legal")).toBe(false);
    expect(isAtOrPast("legal", "complete")).toBe(false);
  });
});

describe("nextStage (forward pointer)", () => {
  it("signup → profile", () => {
    expect(nextStage("signup")).toBe("profile");
  });

  it("profile → legal", () => {
    expect(nextStage("profile")).toBe("legal");
  });

  it("ica → tax_form", () => {
    expect(nextStage("ica")).toBe("tax_form");
  });

  it("review_submitted → complete", () => {
    expect(nextStage("review_submitted")).toBe("complete");
  });

  it("complete has no next stage", () => {
    expect(nextStage("complete")).toBeNull();
  });
});

describe("stage ordering invariants", () => {
  it("ONBOARDING_STAGES contains exactly 12 stages", () => {
    expect(ONBOARDING_STAGES.length).toBe(12);
  });

  it("each stage appears exactly once", () => {
    const seen = new Set<string>();
    for (const s of ONBOARDING_STAGES) {
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });

  it("stages are in strict ascending order per isAtOrPast", () => {
    for (let i = 0; i < ONBOARDING_STAGES.length - 1; i++) {
      const earlier = ONBOARDING_STAGES[i] as OnboardingStage;
      const later = ONBOARDING_STAGES[i + 1] as OnboardingStage;
      expect(isAtOrPast(later, earlier)).toBe(true);
      expect(isAtOrPast(earlier, later)).toBe(false);
    }
  });
});

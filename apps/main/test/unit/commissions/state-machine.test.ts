// Unit tests for commission state machine — §14.2
//
// assertValidTransition is pure (no DB). transitionCommissionState is integration;
// tested here only for the transition-guard path (illegal transition throws before
// any DB call). DB-level tests are deferred to integration suite.

import { describe, it, expect } from "vitest";
import {
  assertValidTransition,
  InvalidCommissionTransitionError,
  type CommissionState,
} from "@/lib/commissions/state-machine";

describe("assertValidTransition (§14.2 state machine)", () => {
  // ── Allowed transitions ───────────────────────────────────────────────────

  describe("expected →", () => {
    const allowed: CommissionState[] = ["invoiced", "received", "partial", "overdue", "disputed", "waived"];
    for (const to of allowed) {
      it(`expected → ${to} is allowed`, () => {
        expect(() => assertValidTransition("expected", to)).not.toThrow();
      });
    }
  });

  describe("invoiced →", () => {
    const allowed: CommissionState[] = ["received", "partial", "disputed", "waived"];
    for (const to of allowed) {
      it(`invoiced → ${to} is allowed`, () => {
        expect(() => assertValidTransition("invoiced", to)).not.toThrow();
      });
    }
  });

  describe("received →", () => {
    const allowed: CommissionState[] = ["partial", "disputed", "waived"];
    for (const to of allowed) {
      it(`received → ${to} is allowed`, () => {
        expect(() => assertValidTransition("received", to)).not.toThrow();
      });
    }
  });

  describe("partial →", () => {
    const allowed: CommissionState[] = ["received", "disputed", "waived"];
    for (const to of allowed) {
      it(`partial → ${to} is allowed`, () => {
        expect(() => assertValidTransition("partial", to)).not.toThrow();
      });
    }
  });

  describe("overdue →", () => {
    const allowed: CommissionState[] = ["received", "partial", "invoiced", "disputed", "waived"];
    for (const to of allowed) {
      it(`overdue → ${to} is allowed`, () => {
        expect(() => assertValidTransition("overdue", to)).not.toThrow();
      });
    }
  });

  describe("disputed →", () => {
    const allowed: CommissionState[] = ["waived", "received", "partial"];
    for (const to of allowed) {
      it(`disputed → ${to} is allowed`, () => {
        expect(() => assertValidTransition("disputed", to)).not.toThrow();
      });
    }
  });

  // ── Terminal state ────────────────────────────────────────────────────────

  describe("waived → (terminal)", () => {
    const allStates: CommissionState[] = [
      "expected", "invoiced", "received", "partial", "overdue", "disputed", "waived",
    ];
    for (const to of allStates) {
      it(`waived → ${to} is ILLEGAL (terminal state)`, () => {
        expect(() => assertValidTransition("waived", to)).toThrow(InvalidCommissionTransitionError);
      });
    }
  });

  // ── Illegal transitions ───────────────────────────────────────────────────

  it("expected → expected (self-transition) is ILLEGAL", () => {
    expect(() => assertValidTransition("expected", "expected")).toThrow(
      InvalidCommissionTransitionError,
    );
  });

  it("received → expected (backwards) is ILLEGAL", () => {
    expect(() => assertValidTransition("received", "expected")).toThrow(
      InvalidCommissionTransitionError,
    );
  });

  it("received → invoiced (backwards) is ILLEGAL", () => {
    expect(() => assertValidTransition("received", "invoiced")).toThrow(
      InvalidCommissionTransitionError,
    );
  });

  it("invoiced → expected (backwards) is ILLEGAL", () => {
    expect(() => assertValidTransition("invoiced", "expected")).toThrow(
      InvalidCommissionTransitionError,
    );
  });

  it("disputed → expected (not in allowed set) is ILLEGAL", () => {
    expect(() => assertValidTransition("disputed", "expected")).toThrow(
      InvalidCommissionTransitionError,
    );
  });

  // ── Error shape ───────────────────────────────────────────────────────────

  it("InvalidCommissionTransitionError carries from and to states", () => {
    try {
      assertValidTransition("waived", "received");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidCommissionTransitionError);
      const err = e as InvalidCommissionTransitionError;
      expect(err.from).toBe("waived");
      expect(err.to).toBe("received");
      expect(err.message).toContain("waived");
      expect(err.message).toContain("received");
    }
  });
});

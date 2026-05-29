// #397 / D-091 — constant-time bearer comparison helper.
//
// The behavior that matters: the function must return the same boolean a
// plain `===` would, WITHOUT short-circuiting on the first byte mismatch
// (that short-circuit is the timing-attack primitive). We can't assert
// wall-clock timing reliably in a unit test, so we pin correctness across
// the equal / same-length-different / different-length / empty cases — a
// regression that swaps this back to `===` still returns the same booleans,
// so the real guard is that the two admin routes CALL this instead of `!==`
// (see bearer-auth-routes.test.ts).

import { describe, it, expect } from "vitest";
import { constantTimeEqual } from "@/lib/auth/constant-time-equal";

describe("constantTimeEqual (#397)", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("service-secret-key", "service-secret-key")).toBe(true);
  });

  it("returns false for same-length but different strings", () => {
    expect(constantTimeEqual("secret-aaaa", "secret-bbbb")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(constantTimeEqual("short", "a-much-longer-secret-value")).toBe(false);
  });

  it("returns false when one side is empty", () => {
    expect(constantTimeEqual("", "non-empty")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

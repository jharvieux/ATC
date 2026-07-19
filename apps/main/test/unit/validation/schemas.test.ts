// #2010 — the shared validation primitives replaced four hand-rolled copies
// (two email regexes, two UUID regexes, a visibility Set) that were free to
// drift. These tests pin the acceptance sets to what those routes enforced, so
// a future edit that silently loosens/tightens one of them fails loudly here
// rather than diverging endpoint-by-endpoint again.

import { describe, it, expect } from "vitest";
import { isValidEmail, isUuid, isGroupVisibilityChoice, GROUP_VISIBILITY_CHOICES } from "@/lib/validation/schemas";

describe("isValidEmail (#2010)", () => {
  it("accepts a normal address", () => {
    expect(isValidEmail("a@example.com")).toBe(true);
  });

  it("rejects an address with no domain dot, whitespace, or empty — the prior regex shape", () => {
    for (const bad of ["", "a@b", "no-at-sign", "a b@example.com", "a@ex ample.com"]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it("rejects an over-length address (>254 chars) — the prior length cap", () => {
    const long = `${"x".repeat(250)}@e.co`; // 256 chars
    expect(long.length).toBeGreaterThan(254);
    expect(isValidEmail(long)).toBe(false);
  });
});

describe("isUuid (#2010)", () => {
  it("accepts a canonical 8-4-4-4-12 hex UUID (case-insensitive)", () => {
    expect(isUuid("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
    expect(isUuid("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe(true);
  });

  it("rejects non-UUID strings the prior UUID_RE also rejected", () => {
    for (const bad of ["not-a-uuid", "a1b2c3d4e5f67890abcdef1234567890", "", "123"]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe("isGroupVisibilityChoice (#2010)", () => {
  it("accepts exactly the three §18.6 roster-visibility choices", () => {
    for (const choice of GROUP_VISIBILITY_CHOICES) {
      expect(isGroupVisibilityChoice(choice)).toBe(true);
    }
    expect(GROUP_VISIBILITY_CHOICES).toEqual(["no_opinion", "be_anonymous", "show_me_anyway"]);
  });

  it("rejects anything outside the enum", () => {
    expect(isGroupVisibilityChoice("public")).toBe(false);
    expect(isGroupVisibilityChoice("")).toBe(false);
  });
});

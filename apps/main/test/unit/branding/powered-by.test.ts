// §16.7 — Powered-by tier-gating rules.
// Imports the real resolveShowPoweredBy used by the branding route so a change to
// the forced-tier set fails this suite (D-091 / #384 — no in-test reimplementation).

import { describe, it, expect } from "vitest";
import { resolveShowPoweredBy } from "@/lib/branding/powered-by";

describe("powered-by visibility tier rules (§16.7)", () => {
  it("byo_research is forced TRUE regardless of request", () => {
    expect(resolveShowPoweredBy("byo_research", false)).toBe(true);
    expect(resolveShowPoweredBy("byo_research", true)).toBe(true);
    expect(resolveShowPoweredBy("byo_research", undefined)).toBe(true);
  });

  it("byo_professional is forced TRUE regardless of request", () => {
    expect(resolveShowPoweredBy("byo_professional", false)).toBe(true);
  });

  it("sub_starter is forced TRUE regardless of request", () => {
    expect(resolveShowPoweredBy("sub_starter", false)).toBe(true);
  });

  it("sub_pro can toggle freely", () => {
    expect(resolveShowPoweredBy("sub_pro", false)).toBe(false);
    expect(resolveShowPoweredBy("sub_pro", true)).toBe(true);
  });

  it("byo_agency can toggle freely", () => {
    expect(resolveShowPoweredBy("byo_agency", false)).toBe(false);
    expect(resolveShowPoweredBy("byo_agency", true)).toBe(true);
  });

  it("sub_agency can toggle freely", () => {
    expect(resolveShowPoweredBy("sub_agency", false)).toBe(false);
    expect(resolveShowPoweredBy("sub_agency", true)).toBe(true);
  });

  it("default for togglable tier is TRUE when requested is undefined", () => {
    expect(resolveShowPoweredBy("sub_pro", undefined)).toBe(true);
    expect(resolveShowPoweredBy("byo_agency", undefined)).toBe(true);
  });

  it("null/undefined tier (tenant or tier lookup miss) defers to the request", () => {
    // Route passes null when the tenant or tier_definitions row is absent.
    expect(resolveShowPoweredBy(null, false)).toBe(false);
    expect(resolveShowPoweredBy(undefined, false)).toBe(false);
    expect(resolveShowPoweredBy(null, undefined)).toBe(true);
  });
});

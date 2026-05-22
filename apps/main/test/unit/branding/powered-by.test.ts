// §16.7 — Powered-by tier-gating rules.
// The branding API forces show_powered_by=TRUE for the three lowest tiers
// regardless of what the tenant sends. Higher tiers can toggle freely.

import { describe, it, expect } from "vitest";

const FORCED_POWERED_BY_TIERS = new Set(["byo_research", "byo_professional", "sub_starter"]);

function resolveShowPoweredBy(tierCode: string, requested: boolean | undefined): boolean {
  if (FORCED_POWERED_BY_TIERS.has(tierCode)) return true;
  return requested ?? true;
}

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
});

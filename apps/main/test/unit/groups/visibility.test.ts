// §18.6 — Anonymity truth table tests for effectiveVisibility.

import { describe, it, expect } from "vitest";
import { effectiveVisibility } from "@/lib/groups/visibility";

describe("effectiveVisibility (§18.6)", () => {
  it("visible + no_opinion → visible", () => {
    expect(effectiveVisibility("visible", "no_opinion")).toBe("visible");
  });

  it("visible + be_anonymous → hidden", () => {
    expect(effectiveVisibility("visible", "be_anonymous")).toBe("hidden");
  });

  it("hidden + no_opinion → hidden", () => {
    expect(effectiveVisibility("hidden", "no_opinion")).toBe("hidden");
  });

  it("hidden + show_me_anyway → hidden (coordinator wins)", () => {
    expect(effectiveVisibility("hidden", "show_me_anyway")).toBe("hidden");
  });

  it("visible + show_me_anyway → visible", () => {
    expect(effectiveVisibility("visible", "show_me_anyway")).toBe("visible");
  });
});

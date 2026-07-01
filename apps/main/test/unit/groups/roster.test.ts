// Pure display-mapping helpers for the group-landing redesign's roster/
// social-proof section (specs/design_handoff_group_landing/).

import { describe, it, expect } from "vitest";
import { deriveDisplayName, avatarColorForId } from "@/lib/groups/roster";

describe("deriveDisplayName", () => {
  it("returns first name + last initial for a full name", () => {
    expect(deriveDisplayName("Jenna Rodriguez")).toBe("Jenna R.");
  });

  it("returns the name as-is when only one word is given", () => {
    expect(deriveDisplayName("Cher")).toBe("Cher");
  });

  it("falls back to a generic label rather than exposing an email, when no name is set", () => {
    expect(deriveDisplayName(null)).toBe("A guest");
    expect(deriveDisplayName("   ")).toBe("A guest");
  });

  it("collapses extra whitespace between name parts", () => {
    expect(deriveDisplayName("  Mike   Torres  ")).toBe("Mike T.");
  });
});

describe("avatarColorForId", () => {
  it("is deterministic for the same id", () => {
    expect(avatarColorForId("inv-abc-123")).toBe(avatarColorForId("inv-abc-123"));
  });

  it("varies across different ids (not a constant)", () => {
    const colors = new Set(
      ["inv-1", "inv-2", "inv-3", "inv-4", "inv-5", "inv-6"].map(avatarColorForId),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

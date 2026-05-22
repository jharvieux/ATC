// Unit tests for mergeMemory — §11.2.5
//
// WHY these tests exist:
// mergeMemory is the conflict-resolution layer between extraction runs.
// A regression here (e.g., null extracted values erasing existing data,
// or loyalty programs deduplicating incorrectly) would silently destroy
// customer data. Each test encodes a specific business rule.

import { describe, it, expect } from "vitest";
import { mergeMemory } from "@/lib/memory/merge";

describe("mergeMemory — new fact", () => {
  it("adds a new field when current is null", () => {
    const result = mergeMemory(
      { preferences: null },
      { preferences: { cabin_type: "balcony" } },
    );
    expect(result.preferences).toEqual({ cabin_type: "balcony" });
  });
});

describe("mergeMemory — conflicting fact (extracted wins)", () => {
  it("extracted value overwrites current non-null value", () => {
    const result = mergeMemory(
      { preferences: { cabin_type: "interior" } },
      { preferences: { cabin_type: "suite" } },
    );
    expect((result.preferences as Record<string, unknown>)?.cabin_type).toBe("suite");
  });

  it("extracted null/undefined does NOT overwrite existing data", () => {
    const result = mergeMemory(
      { notes_freeform: "prefers window seat" },
      { notes_freeform: null },
    );
    expect(result.notes_freeform).toBe("prefers window seat");
  });
});

describe("mergeMemory — loyalty_programs array union", () => {
  it("unions by program_code, extracted wins on conflict", () => {
    const result = mergeMemory(
      {
        loyalty_programs: [
          { program_code: "CARNIVAL_VIFP", tier: "blue" },
          { program_code: "RCCL_CROWNED_ANCHOR", tier: "gold" },
        ],
      },
      {
        loyalty_programs: [
          { program_code: "CARNIVAL_VIFP", tier: "red" }, // override
          { program_code: "NCL_LATITUDE", tier: "silver" }, // new
        ],
      },
    );
    const programs = result.loyalty_programs ?? [];
    expect(programs).toHaveLength(3);
    const carnival = programs.find((p) => p.program_code === "CARNIVAL_VIFP");
    expect(carnival?.tier).toBe("red"); // extracted wins
    const rccl = programs.find((p) => p.program_code === "RCCL_CROWNED_ANCHOR");
    expect(rccl?.tier).toBe("gold"); // current preserved
    const ncl = programs.find((p) => p.program_code === "NCL_LATITUDE");
    expect(ncl?.tier).toBe("silver"); // new from extracted
  });
});

describe("mergeMemory — no-op when extracted is empty", () => {
  it("returns current unchanged when extracted has no non-null fields", () => {
    const current = {
      preferences: { cabin_type: "balcony" },
      notes_freeform: "enjoys early dining",
    };
    const result = mergeMemory(current, {});
    expect(result.preferences).toEqual(current.preferences);
    expect(result.notes_freeform).toBe(current.notes_freeform);
  });
});

describe("mergeMemory — JSONB object shallow merge", () => {
  it("preserves existing keys not present in extracted", () => {
    const result = mergeMemory(
      { travel_history: { cruises_taken: 3, last_destination: "Caribbean" } },
      { travel_history: { cruises_taken: 4 } },
    );
    expect((result.travel_history as Record<string, unknown>)?.cruises_taken).toBe(4);
    expect((result.travel_history as Record<string, unknown>)?.last_destination).toBe("Caribbean");
  });
});

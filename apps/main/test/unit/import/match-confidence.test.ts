// BP34 §34.5.4 — Fuzzy match-confidence scoring tests.
//
// The spec specifies exact component weights. These tests pin each
// component independently AND verify the threshold boundaries
// (high-confidence ≥ 0.85, possible 0.60-0.84, not_surfaced < 0.60).

import { describe, expect, it } from "vitest";
import {
  computeMatchConfidence,
  levenshtein,
} from "../../../src/lib/import/match-confidence";

const REF = {
  cruise_line: "Royal Caribbean",
  ship_name: "Symphony of the Seas",
  sailing_date: "2026-08-15",
  passenger_last_name: "Garcia",
};

describe("levenshtein", () => {
  it("equal strings → 0", () => expect(levenshtein("abc", "abc")).toBe(0));
  it("empty → length", () => expect(levenshtein("", "abcd")).toBe(4));
  it("single substitution", () => expect(levenshtein("cat", "cot")).toBe(1));
  it("insertion", () => expect(levenshtein("cat", "cart")).toBe(1));
  it("deletion", () => expect(levenshtein("cart", "cat")).toBe(1));
  it("two edits", () => expect(levenshtein("Garcia", "Garcas")).toBe(2));
  it("bounds runaway inputs to Infinity", () => {
    expect(levenshtein("x".repeat(100), "y".repeat(100))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("computeMatchConfidence — full-exact match", () => {
  it("identical candidate → 1.00, high_confidence", () => {
    const r = computeMatchConfidence(REF, REF);
    expect(r.confidence).toBe(1);
    expect(r.outcome).toBe("high_confidence");
  });
});

describe("computeMatchConfidence — per-component weights", () => {
  it("cruise_line only → 0.30, not_surfaced", () => {
    const r = computeMatchConfidence(
      { ...REF, ship_name: "X", sailing_date: "2099-01-01", passenger_last_name: "Z" },
      REF,
    );
    expect(r.confidence).toBe(0.3);
    expect(r.outcome).toBe("not_surfaced");
  });

  it("ship_name only → 0.25", () => {
    const r = computeMatchConfidence(
      { ...REF, cruise_line: "X", sailing_date: "2099-01-01", passenger_last_name: "Z" },
      REF,
    );
    expect(r.confidence).toBe(0.25);
  });

  it("sailing_date exact only → 0.25", () => {
    const r = computeMatchConfidence(
      { ...REF, cruise_line: "X", ship_name: "X", passenger_last_name: "Z" },
      REF,
    );
    expect(r.confidence).toBe(0.25);
  });

  it("sailing_date ±7d (not exact) → 0.15", () => {
    const r = computeMatchConfidence(
      { ...REF, cruise_line: "X", ship_name: "X", sailing_date: "2026-08-19", passenger_last_name: "Z" },
      REF,
    );
    expect(r.confidence).toBe(0.15);
  });

  it("sailing_date 8d away → 0", () => {
    const r = computeMatchConfidence(
      { ...REF, cruise_line: "X", ship_name: "X", sailing_date: "2026-08-23", passenger_last_name: "Z" },
      REF,
    );
    expect(r.components.sailing_date).toBe(0);
  });

  it("passenger last name exact only → 0.20", () => {
    const r = computeMatchConfidence(
      { ...REF, cruise_line: "X", ship_name: "X", sailing_date: "2099-01-01" },
      REF,
    );
    expect(r.confidence).toBe(0.2);
  });

  it("passenger last name fuzzy (1 edit) → 0.10", () => {
    const r = computeMatchConfidence(
      { ...REF, cruise_line: "X", ship_name: "X", sailing_date: "2099-01-01", passenger_last_name: "Garcas" },
      REF,
    );
    expect(r.components.passenger_last_name).toBe(0.1);
  });

  it("passenger last name fuzzy too far (3 edits) → 0", () => {
    const r = computeMatchConfidence(
      { ...REF, cruise_line: "X", ship_name: "X", sailing_date: "2099-01-01", passenger_last_name: "Smithe" },
      REF,
    );
    expect(r.components.passenger_last_name).toBe(0);
  });
});

describe("computeMatchConfidence — case + whitespace insensitivity", () => {
  it("uppercase / extra whitespace ⇒ exact match", () => {
    const r = computeMatchConfidence(
      { ...REF, cruise_line: "  ROYAL  CARIBBEAN  ", ship_name: "symphony of the seas" },
      REF,
    );
    expect(r.components.cruise_line).toBe(0.3);
    expect(r.components.ship_name).toBe(0.25);
  });
});

describe("computeMatchConfidence — threshold boundaries", () => {
  it("cruise+ship+sail+name exact = 1.00 → high_confidence", () => {
    expect(computeMatchConfidence(REF, REF).outcome).toBe("high_confidence");
  });

  it("cruise+ship+sail exact, name fuzzy = 0.30+0.25+0.25+0.10 = 0.90 → high_confidence", () => {
    const r = computeMatchConfidence({ ...REF, passenger_last_name: "Garcas" }, REF);
    expect(r.confidence).toBe(0.9);
    expect(r.outcome).toBe("high_confidence");
  });

  it("cruise+ship+sail±7d+name fuzzy = 0.30+0.25+0.15+0.10 = 0.80 → possible", () => {
    const r = computeMatchConfidence(
      { ...REF, sailing_date: "2026-08-20", passenger_last_name: "Garcas" },
      REF,
    );
    expect(r.confidence).toBe(0.8);
    expect(r.outcome).toBe("possible");
  });

  it("cruise+ship = 0.55 → not_surfaced", () => {
    const r = computeMatchConfidence(
      { ...REF, sailing_date: "2099-01-01", passenger_last_name: "Z" },
      REF,
    );
    expect(r.confidence).toBe(0.55);
    expect(r.outcome).toBe("not_surfaced");
  });

  it("cruise+ship+name = 0.75 → possible", () => {
    const r = computeMatchConfidence(
      { ...REF, sailing_date: "2099-01-01" },
      REF,
    );
    expect(r.confidence).toBe(0.75);
    expect(r.outcome).toBe("possible");
  });
});

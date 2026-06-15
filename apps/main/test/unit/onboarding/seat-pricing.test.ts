// §3.3 / §15.8 — Agency seat additional-seat pricing preview.
//
// calculateAgencySeatPreviewCents(additionalSeats, period) where additionalSeats = totalSeats - 1.
// Seat 1 is covered by the base price; this function prices only the additional seats.
//
// Canonical ladder (SEAT_LADDER, single source of truth in abuse/revenue.ts):
//   total seats 2–4  (additional 1–3)  → $59/seat/mo, $590/seat/yr
//   total seats 5–10 (additional 4–9)  → $49/seat/mo, $490/seat/yr
//   total seats 11+  (additional 10+)  → $39/seat/mo, $390/seat/yr
//
// Assertions use total-seat counts in descriptions to match §3.3 spec language,
// but pass (totalSeats - 1) as the argument.

import { describe, it, expect } from "vitest";
import { calculateAgencySeatPreviewCents } from "@/lib/stripe/price-ids";

describe("calculateAgencySeatPreviewCents — canonical §3.3 examples (monthly)", () => {
  it("1 total seat → 0 additional seats → $0", () => {
    expect(calculateAgencySeatPreviewCents(0, "monthly")).toBe(0);
  });

  it("4 total seats → 3 additional → 3 × $59 = $177", () => {
    // All 3 additional seats land in band1 (additional 1–3, $59/seat).
    expect(calculateAgencySeatPreviewCents(3, "monthly")).toBe(3 * 5900); // 17700
  });

  it("10 total seats → 9 additional → 3 × $59 + 6 × $49 = $471", () => {
    // Band1 (additional 1–3): 3 × $59 = $177
    // Band2 (additional 4–9): 6 × $49 = $294
    expect(calculateAgencySeatPreviewCents(9, "monthly")).toBe(3 * 5900 + 6 * 4900); // 47100
  });

  it("12 total seats → 11 additional → 3 × $59 + 6 × $49 + 2 × $39 = $549", () => {
    // Band1 (additional 1–3):  3 × $59 = $177
    // Band2 (additional 4–9):  6 × $49 = $294
    // Band3 (additional 10+):  2 × $39 = $78
    expect(calculateAgencySeatPreviewCents(11, "monthly")).toBe(3 * 5900 + 6 * 4900 + 2 * 3900); // 54900
  });
});

describe("calculateAgencySeatPreviewCents — band boundaries", () => {
  it("band1 cap: 3 additional (seat 4) → still $59 each", () => {
    expect(calculateAgencySeatPreviewCents(3, "monthly")).toBe(3 * 5900);
  });

  it("band2 start: 4 additional (seat 5) → 3 × $59 + 1 × $49 = $226", () => {
    expect(calculateAgencySeatPreviewCents(4, "monthly")).toBe(3 * 5900 + 1 * 4900); // 22600
  });

  it("band2 cap: 9 additional (seat 10) → 3 × $59 + 6 × $49 = $471", () => {
    expect(calculateAgencySeatPreviewCents(9, "monthly")).toBe(3 * 5900 + 6 * 4900); // 47100
  });

  it("band3 start: 10 additional (seat 11) → 3 × $59 + 6 × $49 + 1 × $39 = $510", () => {
    expect(calculateAgencySeatPreviewCents(10, "monthly")).toBe(3 * 5900 + 6 * 4900 + 1 * 3900); // 51000
  });
});

describe("calculateAgencySeatPreviewCents — annual (× 10 per seat)", () => {
  it("4 total seats annual → 3 × $590 = $1,770", () => {
    expect(calculateAgencySeatPreviewCents(3, "annual")).toBe(3 * 59000); // 177000
  });

  it("12 total seats annual → 3 × $590 + 6 × $490 + 2 × $390 = $5,490", () => {
    expect(calculateAgencySeatPreviewCents(11, "annual")).toBe(3 * 59000 + 6 * 49000 + 2 * 39000); // 549000
  });
});

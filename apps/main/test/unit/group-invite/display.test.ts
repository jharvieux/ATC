import { describe, it, expect } from "vitest";
import { avatarInitials, firstNameOnly, daysUntil, routeSummary } from "@/components/group-invite/display";
import type { RosterEntry, ItineraryStop } from "@/components/group-invite/types";

function entry(overrides: Partial<RosterEntry>): RosterEntry {
  return { id: "r-1", displayName: "Jenna R.", anonymous: false, avatarColor: "ocean-blue", status: "booked", ...overrides };
}

describe("avatarInitials", () => {
  it("derives two letters from a named entry", () => {
    expect(avatarInitials(entry({ displayName: "Jenna R." }))).toBe("JR");
  });

  it("never derives initials from an anonymous entry's underlying name", () => {
    expect(avatarInitials(entry({ anonymous: true, displayName: "Anonymous" }))).toBe("?");
  });
});

describe("firstNameOnly", () => {
  it("takes the first word for the social-proof sentence", () => {
    expect(firstNameOnly("Jenna R.")).toBe("Jenna");
  });
});

describe("daysUntil", () => {
  it("never returns negative — a past sail date floors at 0", () => {
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(daysUntil(past)).toBe(0);
  });

  it("counts forward for a future sail date", () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(daysUntil(future)).toBeGreaterThanOrEqual(29);
    expect(daysUntil(future)).toBeLessThanOrEqual(30);
  });
});

describe("routeSummary", () => {
  const stops: ItineraryStop[] = [
    { dayLabel: "Day 1", portName: "Seattle, WA", arrival: null, departure: null, isSeaDay: false },
    { dayLabel: "Day 2", portName: "Inside Passage", arrival: null, departure: null, isSeaDay: true },
    { dayLabel: "Day 3", portName: "Juneau, AK", arrival: null, departure: null, isSeaDay: false },
    { dayLabel: "Day 4", portName: "Seattle, WA", arrival: null, departure: null, isSeaDay: false },
  ];

  it("joins departure port + subsequent non-sea-day stops with an arrow", () => {
    expect(routeSummary("Seattle, WA", stops)).toBe("Seattle, WA → Juneau, AK → Seattle, WA");
  });

  it("skips sea days entirely — no port to name", () => {
    expect(routeSummary("Seattle, WA", stops)).not.toContain("Inside Passage");
  });

  it("returns null when there's no itinerary (legacy free-text group) — omit, don't fabricate", () => {
    expect(routeSummary("Seattle, WA", null)).toBeNull();
  });
});

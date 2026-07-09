// Unit tests for the canonical date-display helper — #1610.
//
// Property under test: formatDate always uses an explicit locale ("en-US"),
// so it can never produce ambient-locale output that would differ between
// SSR and the browser (the hydration-mismatch bug this consolidation fixes).
//
// Dates are built via the local-time Date constructor (new Date(y, m, d)),
// not an ISO UTC string — parsing "...Z" and rendering with
// toLocaleDateString (which uses the runtime's local timezone) would shift
// the displayed day whenever the CI runner's TZ has a negative UTC offset.

import { describe, it, expect } from "vitest";
import { formatDate } from "@/lib/format-date";

const JAN_5_2026 = new Date(2026, 0, 5); // Monday

describe("formatDate", () => {
  it("defaults to numeric en-US format", () => {
    expect(formatDate(JAN_5_2026)).toBe("1/5/2026");
  });

  it("short style omits the year", () => {
    expect(formatDate(JAN_5_2026, "short")).toBe("Jan 5");
  });

  it("medium style includes month, day, and year", () => {
    expect(formatDate(JAN_5_2026, "medium")).toBe("Jan 5, 2026");
  });

  it("long style includes the weekday", () => {
    expect(formatDate(JAN_5_2026, "long")).toBe("Monday, January 5");
  });

  it("returns an em dash for null/undefined", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns an em dash for an invalid date string", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("accepts an ISO date string", () => {
    expect(formatDate("2026-01-05T12:00:00")).toBe("1/5/2026");
  });

  it("accepts an epoch-milliseconds number (Stripe timestamp * 1000 pattern)", () => {
    expect(formatDate(JAN_5_2026.getTime())).toBe("1/5/2026");
  });
});

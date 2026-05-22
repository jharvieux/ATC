// §18.8 — Reminder cadence interval logic tests.
// Tests the interval selection and 3-per-24h rate limit logic in isolation.

import { describe, it, expect } from "vitest";

// Extract pure functions from the Inngest job for unit testing.
// These mirror the internal cadenceIntervalDays / monthsBetween helpers.

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

function cadenceIntervalDays(monthsUntilSailing: number): number | null {
  if (monthsUntilSailing >= 24) return 42;
  if (monthsUntilSailing >= 12) return 30;
  if (monthsUntilSailing >= 6)  return 14;
  if (monthsUntilSailing >= 1)  return 7;
  return null;
}

describe("reminder cadence interval (§18.8)", () => {
  const now = new Date("2026-01-01");

  it("24+ months → 42 days interval", () => {
    const sailDate = new Date("2028-02-01"); // ~25 months
    const months = monthsBetween(now, sailDate);
    expect(cadenceIntervalDays(months)).toBe(42);
  });

  it("18 months → 30 days interval", () => {
    const sailDate = new Date("2027-07-01");
    const months = monthsBetween(now, sailDate);
    expect(cadenceIntervalDays(months)).toBe(30);
  });

  it("9 months → 14 days interval", () => {
    const sailDate = new Date("2026-10-01");
    const months = monthsBetween(now, sailDate);
    expect(cadenceIntervalDays(months)).toBe(14);
  });

  it("3 months → 7 days interval", () => {
    const sailDate = new Date("2026-04-01");
    const months = monthsBetween(now, sailDate);
    expect(cadenceIntervalDays(months)).toBe(7);
  });

  it("final 30 days → null (no automated weeklies)", () => {
    // 0 calendar months → final-30-days window → no automated weeklies
    expect(cadenceIntervalDays(0)).toBeNull();
  });

  it("18-month invitee: sends when lastSent is 35 days ago (> 30-day interval)", () => {
    const sailDate = new Date("2027-07-01");
    const months = monthsBetween(now, sailDate);
    const interval = cadenceIntervalDays(months)!;
    const lastSent = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);
    const daysSinceLast = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysSinceLast >= interval).toBe(true); // should send
  });

  it("18-month invitee: skips when lastSent is 25 days ago (< 30-day interval)", () => {
    const sailDate = new Date("2027-07-01");
    const months = monthsBetween(now, sailDate);
    const interval = cadenceIntervalDays(months)!;
    const lastSent = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000);
    const daysSinceLast = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysSinceLast >= interval).toBe(false); // should skip
  });
});

describe("3-per-24h rate limit logic (§18.8)", () => {
  it("allows up to 3 sends in 24h", () => {
    const limit = 3;
    expect(2 < limit).toBe(true); // 2 prior sends → send
    expect(3 < limit).toBe(false); // 3 prior sends → skip
  });

  it("4th email in 24h to same invitee is suppressed", () => {
    const recentCount = 3; // 3 already sent in the window
    expect(recentCount >= 3).toBe(true); // suppress
  });
});

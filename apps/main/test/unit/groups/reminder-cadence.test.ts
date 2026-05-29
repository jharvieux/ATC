// §18.8 — Reminder cadence interval logic tests.
// Imports the real symbols from the Inngest job's lib module so a change to the
// cadence thresholds fails this suite (D-091 / #384 — no in-test reimplementation).

import { describe, it, expect } from "vitest";
import { cadenceIntervalDays, monthsBetween } from "@/lib/groups/reminder-cadence";

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

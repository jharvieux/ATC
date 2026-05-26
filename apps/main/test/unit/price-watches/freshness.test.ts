// §33.8.3 freshness gate — pure-helper tests.

import { describe, expect, it } from "vitest";
import { isFresh, resolveFreshHours } from "../../../src/lib/price-watches/freshness";

const NOW = Date.parse("2026-05-25T12:00:00Z");

describe("resolveFreshHours", () => {
  it("defaults to 72 when env is undefined", () => {
    expect(resolveFreshHours(undefined)).toBe(72);
  });

  it("returns the parsed value when env is a valid positive number", () => {
    expect(resolveFreshHours("24")).toBe(24);
    expect(resolveFreshHours("168")).toBe(168);
  });

  it("falls back to 72 for non-numeric, zero, or negative input", () => {
    expect(resolveFreshHours("")).toBe(72);
    expect(resolveFreshHours("not-a-number")).toBe(72);
    expect(resolveFreshHours("0")).toBe(72);
    expect(resolveFreshHours("-5")).toBe(72);
  });
});

describe("isFresh", () => {
  it("returns true for a price fetched 1 hour ago with 72h window", () => {
    const oneHourAgo = new Date(NOW - 1 * 3_600_000).toISOString();
    expect(isFresh(oneHourAgo, NOW, 72)).toBe(true);
  });

  it("returns true at the exact boundary (= window)", () => {
    const exact = new Date(NOW - 72 * 3_600_000).toISOString();
    expect(isFresh(exact, NOW, 72)).toBe(true);
  });

  it("returns false just past the boundary", () => {
    const justPast = new Date(NOW - 72 * 3_600_000 - 1).toISOString();
    expect(isFresh(justPast, NOW, 72)).toBe(false);
  });

  it("returns false for stale data older than the window", () => {
    const fourDaysAgo = new Date(NOW - 4 * 24 * 3_600_000).toISOString();
    expect(isFresh(fourDaysAgo, NOW, 72)).toBe(false);
  });

  it("returns false for null fetched_at (never refreshed)", () => {
    expect(isFresh(null, NOW, 72)).toBe(false);
  });

  it("returns false for undefined fetched_at", () => {
    expect(isFresh(undefined, NOW, 72)).toBe(false);
  });

  it("returns false for unparseable fetched_at (data corruption guard)", () => {
    expect(isFresh("not-a-date", NOW, 72)).toBe(false);
  });

  it("respects a tighter custom window (24h)", () => {
    const thirtyHoursAgo = new Date(NOW - 30 * 3_600_000).toISOString();
    // Inside the 72h default, outside the tightened 24h window.
    expect(isFresh(thirtyHoursAgo, NOW, 72)).toBe(true);
    expect(isFresh(thirtyHoursAgo, NOW, 24)).toBe(false);
  });
});

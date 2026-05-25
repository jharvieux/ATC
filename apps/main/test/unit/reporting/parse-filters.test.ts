// BP36 §36.3 — report filter parsing tests.

import { describe, expect, it } from "vitest";
import { parseReportFilters } from "@/lib/reporting/parse-filters";

const base = "https://x.com/api/reports/anything";

describe("parseReportFilters", () => {
  it("returns 90-day trailing default", () => {
    const r = parseReportFilters(new URL(base));
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.start).toBeDefined();
    expect(r.end).toBeDefined();
    expect(r.grouping).toBe("month"); // 90d > 30d → month
  });

  it("uses day grouping when range <= 30d", () => {
    const r = parseReportFilters(new URL(`${base}?start=2026-05-01&end=2026-05-20`));
    if ("error" in r) throw new Error("unexpected error");
    expect(r.grouping).toBe("day");
  });

  it("rejects start after end", () => {
    const r = parseReportFilters(new URL(`${base}?start=2026-06-01&end=2026-05-01`));
    expect("error" in r).toBe(true);
  });

  it("rejects bad date format", () => {
    const r = parseReportFilters(new URL(`${base}?start=05/01/2026&end=2026-05-20`));
    expect("error" in r).toBe(true);
  });

  it("rejects unknown grouping", () => {
    const r = parseReportFilters(new URL(`${base}?grouping=hour`));
    expect("error" in r).toBe(true);
  });

  it("preserves agent filter", () => {
    const r = parseReportFilters(new URL(`${base}?agent_user_id=u-1`));
    if ("error" in r) throw new Error("unexpected error");
    expect(r.agent_user_id).toBe("u-1");
  });
});

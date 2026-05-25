// BP36 §36.8 — CSV export tests.

import { describe, expect, it } from "vitest";
import { rowsToCsv, csvResponse, SYNC_EXPORT_MAX_ROWS } from "@/lib/reporting/csv";

describe("rowsToCsv", () => {
  it("renders headers + rows", () => {
    const csv = rowsToCsv([
      { name: "Alpha", count: 10 },
      { name: "Beta", count: 20 },
    ]);
    expect(csv).toBe("name,count\nAlpha,10\nBeta,20\n");
  });

  it("quotes cells with commas / quotes / newlines", () => {
    const csv = rowsToCsv([{ name: 'O, "Brien"', note: "line1\nline2" }]);
    expect(csv).toContain(`"O, ""Brien"""`);
    expect(csv).toContain(`"line1\nline2"`);
  });

  it("converts *_cents columns to plain decimal dollars with currency column", () => {
    const csv = rowsToCsv([
      { name: "x", gross_commission_cents: 12345, currency: "USD" },
    ]);
    expect(csv).toContain("gross_commission,currency");
    expect(csv).toContain("123.45,USD");
    expect(csv).not.toContain("_cents");
  });

  it("defaults currency to USD when not provided", () => {
    const csv = rowsToCsv([{ total_amount_cents: 100000 }]);
    expect(csv).toContain("1000.00,USD");
  });

  it("returns empty string for empty array", () => {
    expect(rowsToCsv([])).toBe("");
  });

  it("handles null/undefined cells", () => {
    const csv = rowsToCsv([{ a: null, b: undefined, c: "x" }]);
    expect(csv).toBe("a,b,c\n,,x\n");
  });
});

describe("csvResponse", () => {
  it("sets content-type + content-disposition", () => {
    const res = csvResponse([{ a: 1 }], "test.csv");
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="test.csv"');
  });
});

describe("SYNC_EXPORT_MAX_ROWS", () => {
  it("is set to spec value", () => {
    expect(SYNC_EXPORT_MAX_ROWS).toBe(10_000);
  });
});

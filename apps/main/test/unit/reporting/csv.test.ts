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

describe("csvCell — formula injection prevention (#727)", () => {
  it("neutralizes =, +, -, @ prefixes so spreadsheet apps cannot execute them as formulas", () => {
    // Security property: after CSV parsing, the first character the spreadsheet app
    // sees must NOT be a formula initiator. Quoting alone doesn't suffice — Excel
    // strips quotes before evaluating. A tab prefix is the correct neutralization.
    const dangerous = [
      '=HYPERLINK("http://evil.com","click")',
      "+cmd|'evil'",
      "-2+3+cmd|'evil'",
      "@SUM(1+1)*cmd|'evil'",
    ];
    for (const input of dangerous) {
      const csv = rowsToCsv([{ value: input }]);
      const dataLine = csv.split("\n")[1] ?? "";
      // Strip CSV quoting to get what the spreadsheet app sees after parsing.
      const cell = dataLine.startsWith('"')
        ? dataLine.slice(1, dataLine.lastIndexOf('"')).replace(/""/g, '"')
        : dataLine;
      expect(cell, `"${input}" must be neutralized`).not.toMatch(/^[=+\-@]/);
    }
  });

  it("does not alter safe values without formula prefix", () => {
    const csv = rowsToCsv([{ utm_source: "google", campaign: "summer2026" }]);
    expect(csv).toBe("utm_source,campaign\ngoogle,summer2026\n");
  });
});

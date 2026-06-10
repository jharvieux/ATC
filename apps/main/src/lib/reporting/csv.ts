// BP36 §36.8 — CSV export helpers.
//
// Money columns rendered as plain decimal dollars with a separate
// currency column (not cents) per §36.8. Other columns pass through as-is.

const CENT_FIELD_SUFFIX = "_cents";

export type Csvable = Record<string, unknown>;

export function rowsToCsv(rows: Csvable[]): string {
  if (rows.length === 0) return "";

  const expandedRows = rows.map(expandMoneyFields);
  const headers = collectHeaders(expandedRows);
  const lines: string[] = [headers.join(",")];

  for (const row of expandedRows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

export function csvResponse(rows: Csvable[], filename: string): Response {
  const body = rowsToCsv(rows);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// §36.8 — convert *_cents columns to plain decimal dollars + separate
// currency. The original *_cents field is dropped from the output.
function expandMoneyFields(row: Csvable): Csvable {
  const out: Csvable = {};
  const currency = (row.currency as string | undefined) ?? "USD";
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith(CENT_FIELD_SUFFIX)) {
      const dollarKey = k.slice(0, -CENT_FIELD_SUFFIX.length);
      out[dollarKey] = typeof v === "number" ? (v / 100).toFixed(2) : v;
      if (!Object.prototype.hasOwnProperty.call(out, "currency")) {
        out.currency = currency;
      }
    } else if (k === "currency") {
      // emitted via the cent-field branch when present; otherwise keep here
      if (!Object.prototype.hasOwnProperty.call(out, "currency")) out.currency = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function collectHeaders(rows: Csvable[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v);
  }
  // #727: neutralize CSV formula injection — prepend tab so spreadsheet apps
  // don't evaluate cells starting with =, +, -, @ as formulas. CSV quoting
  // alone doesn't prevent execution: Excel strips quotes before evaluating.
  if (/^[=+\-@]/.test(s)) {
    s = `\t${s}`;
  }
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r") || s.includes("\t")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// §36.8 — synchronous export ceiling.
export const SYNC_EXPORT_MAX_ROWS = 10_000;

// Convenience for the report routes: returns CSV (with §36.8 row cap
// guard) when ?format=csv, otherwise returns JSON with the supplied
// shape. Routes call this at the end and ship a single line.
export function respondCsvOrJson(args: {
  format: string | null;
  items: Csvable[];
  csv_filename: string;
  json_body: Record<string, unknown>;
}): Response {
  if (args.format === "csv") {
    if (args.items.length > SYNC_EXPORT_MAX_ROWS) {
      return Response.json(
        {
          error: "export_too_large",
          max_rows: SYNC_EXPORT_MAX_ROWS,
          actual_rows: args.items.length,
          message: "Use the async export endpoint (Phase B; not yet wired).",
        },
        { status: 413 },
      );
    }
    return csvResponse(args.items, args.csv_filename);
  }
  return Response.json(args.json_body);
}

// §33.4 D-088 — CruiseMapper price-range parser.
//
// CruiseMapper ship pages publish "Price range from $X to $Y" widgets
// per cabin tier. This parser extracts those into a structured form.
// Determinism matters because the §33.5 ingest pipeline uses a hash of
// the extracted content to skip unchanged refresh runs.
//
// Robustness: returns an EMPTY array (not null) if the page has no
// price widget. The caller treats empty as "this ship has no price
// data in the HTML right now" — distinct from a parse failure on the
// surrounding ship-spec fields (which the ship-parser handles).

import * as cheerio from "cheerio";

export type CabinClass = "interior" | "oceanview" | "balcony" | "mini_suite" | "suite";

export interface PriceRangeRow {
  cabin_class: CabinClass;
  duration_nights: number;
  low_amount: number;
  high_amount: number;
  source_url: string;
}

const CABIN_LABEL_TO_CLASS: ReadonlyArray<[RegExp, CabinClass]> = [
  // Order matters — longest match first.
  [/mini[\s-]?suite/i, "mini_suite"],
  [/suite/i, "suite"],
  [/balcon(y|ies)/i, "balcony"],
  [/ocean[\s-]?view/i, "oceanview"],
  [/(?:interior|inside)/i, "interior"],
];

function classifyCabinLabel(label: string): CabinClass | null {
  for (const [re, cls] of CABIN_LABEL_TO_CLASS) {
    if (re.test(label)) return cls;
  }
  return null;
}

function parseDollarAmount(s: string): number | null {
  // Handles "$1,234", "$1,234.50", "1234" — defensive against unicode quotes.
  const m = /\$?\s*([0-9][0-9,]*\.?\d*)/.exec(s);
  if (!m) return null;
  const n = parseFloat((m[1] ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseDurationNights(s: string): number | null {
  // "7-night", "14 nights", "7 day", "10nt", "7night" — hyphen, space, or none.
  const m = /(\d{1,3})[\s-]*(?:nt|night|day)/i.exec(s);
  if (!m) return null;
  const n = parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 && n < 200 ? n : null;
}

/**
 * Parse a CruiseMapper ship page for cabin price-range data.
 * Returns one row per (cabin_class, duration_nights) pair found.
 *
 * Resilient to two HTML patterns CruiseMapper has used:
 *   A) <table class="prices"><tr><th>Cabin</th>...<td>$lo-$hi</td>...</tr>
 *   B) <ul class="pricing">
 *        <li><span class="cabin-type">Balcony</span>
 *            <span class="range">$1,200 - $3,500</span>
 *            <span class="duration">7-night</span></li>
 *      </ul>
 *
 * If neither pattern is present, an empty array is returned and the
 * caller treats the ship as price-unavailable. Schema layouts CruiseMapper
 * has used in the past are tolerated; new layouts return empty until
 * the parser is extended.
 */
export function parsePriceRanges(html: string, sourceUrl: string): PriceRangeRow[] {
  const $ = cheerio.load(html);
  const rows: PriceRangeRow[] = [];

  // Pattern A — table-shaped.
  $("table").each((_, table) => {
    const headerText = $(table).find("th").map((_i, th) => $(th).text().trim().toLowerCase()).get().join(" ");
    if (!headerText.includes("cabin") && !headerText.includes("price")) return;

    $(table).find("tbody tr").each((_i, tr) => {
      const cells = $(tr).find("td").map((_j, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      // Heuristic: first column = cabin label, look for $ + dash for price range.
      const cabinLabel = cells[0] ?? "";
      const cls = classifyCabinLabel(cabinLabel);
      if (!cls) return;

      const rangeCell = cells.find((c) => /\$[\d,]+.*[-–—].*\$[\d,]+/.test(c));
      if (!rangeCell) return;
      const m = /\$\s*([0-9][0-9,]*\.?\d*)\s*[-–—]\s*\$?\s*([0-9][0-9,]*\.?\d*)/.exec(rangeCell);
      if (!m) return;
      const lo = parseDollarAmount(m[1] ?? "");
      const hi = parseDollarAmount(m[2] ?? "");
      if (lo === null || hi === null || hi < lo) return;

      // Duration: search the row for an "N-night" token, falling back to
      // searching the table caption.
      const rowText = cells.join(" ");
      const captionText = $(table).find("caption").text();
      const dur =
        parseDurationNights(rowText) ?? parseDurationNights(captionText) ?? null;
      if (dur === null) return;

      rows.push({
        cabin_class: cls,
        duration_nights: dur,
        low_amount: lo,
        high_amount: hi,
        source_url: sourceUrl,
      });
    });
  });

  // Pattern B — list-shaped.
  $("ul.pricing li, ul.price-range li, .ship-prices li").each((_i, li) => {
    const cabinLabel = $(li).find(".cabin-type, .cabin, .type").first().text().trim();
    const rangeText = $(li).find(".range, .price-range, .price").first().text().trim();
    const durationText = $(li).find(".duration, .nights").first().text().trim();
    if (!cabinLabel || !rangeText) return;

    const cls = classifyCabinLabel(cabinLabel);
    if (!cls) return;

    const m = /\$\s*([0-9][0-9,]*\.?\d*)\s*[-–—]\s*\$?\s*([0-9][0-9,]*\.?\d*)/.exec(rangeText);
    if (!m) return;
    const lo = parseDollarAmount(m[1] ?? "");
    const hi = parseDollarAmount(m[2] ?? "");
    if (lo === null || hi === null || hi < lo) return;

    const dur = parseDurationNights(durationText) ?? parseDurationNights($(li).text());
    if (dur === null) return;

    rows.push({
      cabin_class: cls,
      duration_nights: dur,
      low_amount: lo,
      high_amount: hi,
      source_url: sourceUrl,
    });
  });

  // De-dup on (cabin_class, duration_nights) — patterns A and B can
  // overlap on the same page. Keep the first occurrence.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.cabin_class}|${r.duration_nights}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

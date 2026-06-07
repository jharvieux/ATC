// #827 §33.4 — CruiseMapper per-sailing detail (cruise.json) parser.
//
// The upcoming-sailings LIST (shipTableCruise) carries no ports — only date,
// title, embark port, duration, price. Each row's full day-by-day is loaded
// lazily by the page JS from:
//   GET /ships/cruise.json?id=<data-row>   (requires X-Requested-With: XMLHttpRequest)
//   → { "result": "<table class='cruiseExpand'> … </table> …" }
// The fragment's rows use the SAME td.date / td.text / /ports/ link / Departing
// / Arriving shape as the ship page's current-itinerary table, so we reuse
// classifyItineraryRows + assembleItinerary from sailing-parser.
//
// The fragment has NO prose, so the calendar year comes from the caller's known
// departure_date (from the list row), and the return date from
// departure_date + duration_nights — both authoritative, no inference needed.

import * as cheerio from "cheerio";
import { classifyItineraryRows, assembleItinerary, addDays, type ParsedSailingDay } from "./sailing-parser";

export interface CruiseExpandResult {
  ports_of_call: string[];
  itinerary: ParsedSailingDay[];
}

// "YYYY-MM-DD" → { year, monthIdx, day }; null if malformed.
function parseIsoYmd(iso: string): { year: number; monthIdx: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const year = parseInt(m[1] ?? "", 10);
  const monthIdx = parseInt(m[2] ?? "", 10) - 1;
  const day = parseInt(m[3] ?? "", 10);
  if (!Number.isFinite(year) || monthIdx < 0 || monthIdx > 11 || !Number.isFinite(day)) return null;
  return { year, monthIdx, day };
}

/**
 * Parse the HTML fragment from /ships/cruise.json (the `result` field) into the
 * sailing's ports of call + full day-by-day. Returns null when the fragment has
 * no itinerary table or the caller's date/duration are invalid — the caller
 * then leaves the sailing un-enriched (no ports) rather than guessing.
 */
export function parseCruiseExpand(
  fragmentHtml: string,
  ctx: { departureDate: string; durationNights: number },
): CruiseExpandResult | null {
  const begin = parseIsoYmd(ctx.departureDate);
  if (!begin || !Number.isFinite(ctx.durationNights) || ctx.durationNights <= 0) return null;

  const $ = cheerio.load(fragmentHtml);
  const table = $("table.cruiseExpand").first();
  const resolved = table.length > 0 ? table : $("table").first();
  if (resolved.length === 0) return null;

  const rows = classifyItineraryRows($, resolved);
  if (rows.length === 0) return null;

  const end = parseIsoYmd(addDays(ctx.departureDate, ctx.durationNights));
  const { ports_of_call, itinerary } = assembleItinerary(rows, begin, end);
  return { ports_of_call, itinerary };
}

// #485 §33.4 — CruiseMapper sailing/itinerary parser.
//
// Reality (verified against a live ship page, 2026-05-30): per-day itinerary
// data lives on the SHIP page, not a separate /cruises/<slug> page. The
// "Current itinerary of <ship>" block holds one fully-detailed day-by-day
// table (div.cruiseItinerariesCurrent > table). This parser extracts that
// sailing.
//
// Two structural facts that drive the logic:
//   1. SEA DAYS ARE IMPLICIT. The table lists only port days + embark/
//      disembark; a day with no port (e.g. a crossing) is simply absent.
//      We reconstruct sea days by filling calendar-date gaps between the
//      embark and disembark dates.
//   2. ROW DATES CARRY NO YEAR ("01 Jun 10:00 - 18:00"). The year comes from
//      the surrounding prose ("begins on May 30, 2026 and ends on June 6,
//      2026"). We anchor on the begin year and roll it forward on a Dec→Jan
//      month wrap.
//
// Determinism: same HTML → same `text` (RAG content_hash idempotency).
// Returns null when the page lacks the structures we depend on, so the
// caller can mark parse_failed and the run halts above the 5% failure floor.

import * as cheerio from "cheerio";

export interface ParsedSailingDay {
  day_number: number; // 1-indexed calendar day from embark
  date: string; // YYYY-MM-DD
  port_name: string | null; // null = at sea
  arrival_time: string | null; // HH:MM
  departure_time: string | null; // HH:MM
}

export interface ParsedSailing {
  cruise_line: string | null;
  ship_name: string;
  ship_slug: string;
  departure_date: string; // YYYY-MM-DD
  return_date: string; // YYYY-MM-DD
  duration_nights: number;
  departure_port: string;
  ports_of_call: string[]; // ordered, ports only (no sea days, no turnaround)
  itinerary: ParsedSailingDay[]; // full day-by-day, includes sea days
  region: string | null;
  starting_price_usd: number | null;
  sailing_slug: string;
  source_url: string;
  text: string; // RAG-ready prose, deterministic
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Broad cruise regions we can recognize from a CruiseMapper cruise title.
// #486 owns authoritative region classification; this is only a cheap hint
// pulled from the title when one of these tokens is present.
const REGION_TOKENS = [
  "Alaska", "Caribbean", "Bahamas", "Mexico", "Mexican Riviera", "Hawaii",
  "Mediterranean", "Baltic", "Norwegian Fjords", "Northern Europe", "Europe",
  "Transatlantic", "Panama Canal", "South America", "Australia", "New Zealand",
  "Asia", "Antarctica", "Greek Isles", "Bermuda", "Canada", "New England",
];

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isoDate(year: number, monthIdx: number, day: number): string {
  const mm = String(monthIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function daysBetween(startIso: string, endIso: string): number {
  const a = Date.parse(`${startIso}T00:00:00Z`);
  const b = Date.parse(`${endIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function addDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function shipSlugFromUrl(url: string): string {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return (segs[segs.length - 1] ?? "").replace(/\.html?$/i, "");
  } catch {
    return "";
  }
}

interface RawRow {
  day: number;
  monthIdx: number;
  times: string[];
  portName: string | null;
  isEmbark: boolean;
  isDisembark: boolean;
}

// "01 Jun 10:00 - 18:00" → { day:1, monthIdx:5, times:["10:00","18:00"] }
// "02 Jun" → { day:2, monthIdx:5, times:[] }
function parseDateCell(raw: string): { day: number; monthIdx: number; times: string[] } | null {
  const m = /^\s*(\d{1,2})\s+([A-Za-z]{3,})\s*(.*)$/.exec(collapse(raw));
  if (!m) return null;
  const day = parseInt(m[1] ?? "", 10);
  const monthIdx = MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];
  if (!Number.isFinite(day) || monthIdx === undefined) return null;
  const times = [...(m[3] ?? "").matchAll(/(\d{1,2}:\d{2})/g)].map((t) => t[1] ?? "");
  return { day, monthIdx, times };
}

function parsePriceUsd($p: string): number | null {
  const m = /(?:USD|US\$|\$)\s*([\d,]+)/i.exec($p);
  if (!m) return null;
  const v = parseInt((m[1] ?? "").replace(/,/g, ""), 10);
  return Number.isFinite(v) ? v : null;
}

// "May 30, 2026" → { year, monthIdx, day }
function parseLongDate(s: string): { year: number; monthIdx: number; day: number } | null {
  const m = /([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  if (!m) return null;
  const monthIdx = MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
  const day = parseInt(m[2] ?? "", 10);
  const year = parseInt(m[3] ?? "", 10);
  if (monthIdx === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return { year, monthIdx, day };
}

function regionFromTitle(title: string): string | null {
  for (const token of REGION_TOKENS) {
    if (new RegExp(`\\b${token}\\b`, "i").test(title)) return token;
  }
  return null;
}

export function parseSailingPage(html: string, sourceUrl: string): ParsedSailing | null {
  const $ = cheerio.load(html);

  const shipName = collapse($("h1").first().text());
  if (!shipName) return null;

  const table = $(".cruiseItinerariesCurrent table").first();
  if (table.length === 0) return null;

  // Current-cruise prose paragraph: "<title strong>. Prices start from USD
  // 919 ... begins on May 30, 2026 and ends on June 6, 2026." Scope to this
  // <p> so the price/title don't bleed in from the all-itineraries list.
  const proseEl = $("#current_cruise").nextAll("p").first();
  const prose = collapse(proseEl.text()) || collapse($("body").text());
  const beginMatch = /begins on\s+([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/i.exec(prose);
  const endMatch = /ends on\s+([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/i.exec(prose);
  const begin = beginMatch ? parseLongDate(beginMatch[1] ?? "") : null;
  if (!begin) return null;
  const end = endMatch ? parseLongDate(endMatch[1] ?? "") : null;

  const title = collapse(proseEl.find("strong").first().text())
    || collapse($(".cruiseTitle").first().text());
  const region = title ? regionFromTitle(title) : null;
  const starting_price_usd = parsePriceUsd(prose);

  // Walk the day rows.
  const rows: RawRow[] = [];
  table.find("tr").each((_, tr) => {
    const dateText = collapse($(tr).find("td.date").first().text());
    if (!dateText) return; // header / spacer row
    const parsed = parseDateCell(dateText);
    if (!parsed) return;
    const textCell = $(tr).find("td.text").first();
    const portLink = textCell
      .find('a[href*="/ports/"]')
      .filter((__, a) => !$(a).hasClass("itineraryHotelsText"))
      .first();
    const portName = portLink.length ? collapse(portLink.text()) : null;
    const cellText = collapse(textCell.text());
    rows.push({
      day: parsed.day,
      monthIdx: parsed.monthIdx,
      times: parsed.times,
      portName,
      isEmbark: /Departing/i.test(cellText),
      isDisembark: /Arriving/i.test(cellText),
    });
  });
  if (rows.length === 0) return null;

  // Assign a calendar year to each row: anchor on the begin year, roll
  // forward whenever the month index drops (Dec → Jan).
  let year = begin.year;
  let prevMonth = rows[0]?.monthIdx ?? begin.monthIdx;
  const dated = rows.map((r) => {
    if (r.monthIdx < prevMonth) year += 1;
    prevMonth = r.monthIdx;
    const date = isoDate(year, r.monthIdx, r.day);
    let arrival: string | null = null;
    let departure: string | null = null;
    if (r.isEmbark) {
      departure = r.times[0] ?? null;
    } else if (r.isDisembark) {
      arrival = r.times[0] ?? null;
    } else {
      arrival = r.times[0] ?? null;
      departure = r.times[1] ?? null;
    }
    return { ...r, date, arrival, departure };
  });

  const departure_date = isoDate(begin.year, begin.monthIdx, begin.day);
  const return_date = end
    ? isoDate(end.year, end.monthIdx, end.day)
    : (dated[dated.length - 1]?.date ?? departure_date);

  const departure_port =
    dated.find((d) => d.isEmbark)?.portName ?? dated[0]?.portName ?? "";

  // Fill sea-day gaps and assign 1-indexed day numbers from the embark date.
  const span = Math.max(0, daysBetween(departure_date, return_date));
  const byDate = new Map<string, typeof dated>();
  for (const d of dated) {
    const list = byDate.get(d.date) ?? [];
    list.push(d);
    byDate.set(d.date, list);
  }
  const itinerary: ParsedSailingDay[] = [];
  for (let i = 0; i <= span; i += 1) {
    const date = addDays(departure_date, i);
    const dayNum = i + 1;
    const onThisDate = byDate.get(date);
    if (onThisDate && onThisDate.length > 0) {
      for (const d of onThisDate) {
        itinerary.push({
          day_number: dayNum,
          date,
          port_name: d.portName,
          arrival_time: d.arrival,
          departure_time: d.departure,
        });
      }
    } else {
      itinerary.push({ day_number: dayNum, date, port_name: null, arrival_time: null, departure_time: null });
    }
  }

  const ports_of_call = dated
    .filter((d) => !d.isEmbark && !d.isDisembark && d.portName)
    .map((d) => d.portName as string);

  const cruise_line =
    collapse($('a[href*="/cruise-lines/"]').first().find('[itemprop="name"]').text()) ||
    collapse($('a[href*="/cruise-lines/"]').first().text()) ||
    null;

  const ship_slug = shipSlugFromUrl(sourceUrl);
  const duration_nights = span;
  const sailing_slug = `${ship_slug}__${departure_date}`;

  const text = renderSailingText({
    ship_name: shipName, cruise_line, departure_date, return_date,
    duration_nights, departure_port, ports_of_call, region, starting_price_usd,
  });

  return {
    cruise_line, ship_name: shipName, ship_slug,
    departure_date, return_date, duration_nights,
    departure_port, ports_of_call, itinerary, region,
    starting_price_usd, sailing_slug, source_url: sourceUrl, text,
  };
}

function renderSailingText(s: {
  ship_name: string; cruise_line: string | null; departure_date: string;
  return_date: string; duration_nights: number; departure_port: string;
  ports_of_call: string[]; region: string | null; starting_price_usd: number | null;
}): string {
  const parts: string[] = [];
  const reg = s.region ? `${s.region} ` : "";
  parts.push(
    `${s.ship_name}${s.cruise_line ? ` (${s.cruise_line})` : ""} sails a ${s.duration_nights}-night ${reg}cruise`,
  );
  parts.push(`departing ${s.departure_port} on ${s.departure_date} and returning ${s.return_date}.`);
  const line1 = parts.join(" ");
  const line2 = s.ports_of_call.length
    ? `Ports of call: ${s.ports_of_call.join(", ")}.`
    : "No scheduled ports (full sea-day itinerary).";
  const line3 = s.starting_price_usd ? `Fares from USD ${s.starting_price_usd}.` : "";
  return [line1, line2, line3].filter(Boolean).join(" ");
}

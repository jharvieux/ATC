// #485 follow-up §33.4 — CruiseMapper upcoming-sailings list parser.
//
// Parses table.shipTableCruise on a ship page. This table lists every
// upcoming sailing with metadata only (no per-day breakdown). Each row is:
//   td.cruiseDatetime  "2026 Apr 25"   (YYYY Mon DD)
//   td.cruiseTitle     "7 days, round-trip Alaska …"
//   td.cruiseDeparture flag-icon + city name
//   td.cruisePrice     "$789"
//
// Row dates carry a full year (unlike the current-itinerary table which uses
// "DD Mon HH:MM" and requires year inference from prose).
//
// Returns [] when the table is absent — not a failure condition; some ship
// pages omit the list if no upcoming sailings are scheduled.

import * as cheerio from "cheerio";
import { regionFromTitle } from "./sailing-parser";

export interface SailingListItem {
  data_row_id: string;
  title: string;
  departure_date: string;      // YYYY-MM-DD
  departure_port: string;
  duration_nights: number;
  starting_price_usd: number | null;
  region: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// "2026 Apr 25" → "2026-04-25"
function parseDatetime(raw: string): string | null {
  const m = /^(\d{4})\s+([A-Za-z]{3,})\s+(\d{1,2})$/.exec(collapse(raw));
  if (!m) return null;
  const year = parseInt(m[1] ?? "", 10);
  const monthIdx = MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];
  const day = parseInt(m[3] ?? "", 10);
  if (!Number.isFinite(year) || monthIdx === undefined || !Number.isFinite(day)) return null;
  return `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "7 days, round-trip …" → 7
function parseDurationNights(title: string): number | null {
  const m = /^(\d+)\s+days?/i.exec(title.trim());
  if (!m) return null;
  const n = parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "$789" or "$1,089" → 789 / 1089
function parsePriceUsd(raw: string): number | null {
  const m = /\$\s*([\d,]+)/.exec(raw);
  if (!m) return null;
  const v = parseInt((m[1] ?? "").replace(/,/g, ""), 10);
  return Number.isFinite(v) ? v : null;
}

export function parseSailingList(html: string): SailingListItem[] {
  const $ = cheerio.load(html);
  const items: SailingListItem[] = [];

  $("table.shipTableCruise tbody tr[data-row]").each((_, tr) => {
    const dataRowId = $(tr).attr("data-row");
    if (!dataRowId) return;

    const dateRaw = collapse($(tr).find("td.cruiseDatetime").text());
    const departureDate = parseDatetime(dateRaw);
    if (!departureDate) return;

    const titleRaw = collapse($(tr).find("td.cruiseTitle").clone().find("i").remove().end().text());
    if (!titleRaw) return;

    const durationNights = parseDurationNights(titleRaw);
    if (durationNights === null) return;

    // Strip the flag <i> (no text content) then take remaining text.
    const portCell = $(tr).find("td.cruiseDeparture");
    const departurePort = collapse(portCell.clone().find("i").remove().end().text());
    if (!departurePort) return;

    const priceRaw = collapse($(tr).find("td.cruisePrice").text());
    const startingPriceUsd = parsePriceUsd(priceRaw);

    items.push({
      data_row_id: dataRowId,
      title: titleRaw,
      departure_date: departureDate,
      departure_port: departurePort,
      duration_nights: durationNights,
      starting_price_usd: startingPriceUsd,
      region: regionFromTitle(titleRaw),
    });
  });

  return items;
}

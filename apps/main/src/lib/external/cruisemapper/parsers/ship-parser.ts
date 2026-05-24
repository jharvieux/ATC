// BP36 §33.5 — CruiseMapper ship registry parser.
//
// Returns null when the page structure looks fundamentally different
// from what we expect — caller increments the failure counter and the
// Inngest job halts the run if the failure rate exceeds 5%.
//
// Determinism: same HTML → same text output (so the RAG content_hash
// idempotency works for unchanged pages).

import * as cheerio from "cheerio";

export interface ParsedShip {
  shipName: string;
  cruiseLine: string | null;
  yearBuilt: number | null;
  builder: string | null;
  shipClass: string | null;
  flagState: string | null;
  lengthMeters: number | null;
  beamMeters: number | null;
  draftMeters: number | null;
  grossTonnage: number | null;
  passengerCapacity: number | null;
  crewCount: number | null;
  deckCount: number | null;
  cabinCount: number | null;
  /** Stable URL slug — e.g., 'symphony-of-the-seas-1234'. */
  shipSlug: string;
  sourceUrl: string;
  /** Dense prose suitable for RAG ingest. Deterministic. */
  text: string;
}

function num(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /(-?\d[\d,]*\.?\d*)/.exec(s);
  if (!m) return null;
  const v = parseFloat((m[1] ?? "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

function pickSpecValue($: cheerio.CheerioAPI, labels: string[]): string | null {
  // CruiseMapper's spec layouts vary: try a few common patterns.
  for (const label of labels) {
    // Pattern A: <th>Label</th><td>value</td>
    const a = $(`th:contains("${label}")`).first().next("td").text().trim();
    if (a) return a;
    // Pattern B: <dt>Label</dt><dd>value</dd>
    const b = $(`dt:contains("${label}")`).first().next("dd").text().trim();
    if (b) return b;
    // Pattern C: <li><span class="label">Label</span><span>value</span></li>
    const c = $(`li:contains("${label}")`).first().find("span").last().text().trim();
    if (c && c.toLowerCase() !== label.toLowerCase()) return c;
  }
  return null;
}

function shipSlugFromUrl(url: string): string {
  const u = new URL(url);
  // Last non-empty path segment, sans .html
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  return last.replace(/\.html?$/i, "");
}

export function parseShipPage(html: string, sourceUrl: string): ParsedShip | null {
  const $ = cheerio.load(html);

  const shipName = $("h1").first().text().trim();
  if (!shipName) return null;

  const cruiseLine = pickSpecValue($, ["Cruise line", "Owner", "Operator"]);
  const yearBuilt  = num(pickSpecValue($, ["Year built", "Built", "Year of build"]));
  const builder    = pickSpecValue($, ["Builder", "Shipyard"]);
  const shipClass  = pickSpecValue($, ["Class", "Ship class"]);
  const flagState  = pickSpecValue($, ["Flag", "Flag state", "Registry"]);
  const lengthM    = num(pickSpecValue($, ["Length", "LOA"]));
  const beamM      = num(pickSpecValue($, ["Beam", "Width"]));
  const draftM     = num(pickSpecValue($, ["Draft", "Draught"]));
  const grossTon   = num(pickSpecValue($, ["GT", "Gross tonnage"]));
  const paxCap     = num(pickSpecValue($, ["Passengers", "Guest capacity"]));
  const crewCount  = num(pickSpecValue($, ["Crew", "Crew count"]));
  const deckCount  = num(pickSpecValue($, ["Decks", "Deck count"]));
  const cabinCount = num(pickSpecValue($, ["Cabins", "Cabin count", "Staterooms"]));

  // Sanity: if more than half the spec fields are null, the page layout has
  // probably changed. Return null so caller marks parse_failed.
  const specs = [cruiseLine, yearBuilt, builder, shipClass, flagState, lengthM, beamM, draftM, grossTon, paxCap, crewCount, deckCount, cabinCount];
  const nonNull = specs.filter((v) => v !== null).length;
  if (nonNull < Math.ceil(specs.length / 2)) return null;

  const shipSlug = shipSlugFromUrl(sourceUrl);

  const text = renderShipText({
    shipName, cruiseLine, yearBuilt, builder, shipClass, flagState,
    lengthMeters: lengthM, beamMeters: beamM, draftMeters: draftM,
    grossTonnage: grossTon, passengerCapacity: paxCap, crewCount,
    deckCount, cabinCount,
  });

  return {
    shipName, cruiseLine, yearBuilt, builder, shipClass, flagState,
    lengthMeters: lengthM, beamMeters: beamM, draftMeters: draftM,
    grossTonnage: grossTon, passengerCapacity: paxCap, crewCount,
    deckCount, cabinCount,
    shipSlug, sourceUrl, text,
  };
}

function renderShipText(s: {
  shipName: string; cruiseLine: string | null; yearBuilt: number | null;
  builder: string | null; shipClass: string | null; flagState: string | null;
  lengthMeters: number | null; beamMeters: number | null; draftMeters: number | null;
  grossTonnage: number | null; passengerCapacity: number | null;
  crewCount: number | null; deckCount: number | null; cabinCount: number | null;
}): string {
  // Deterministic prose. Order matters for hash stability.
  const parts: string[] = [];
  parts.push(`${s.shipName} is a cruise ship`);
  if (s.cruiseLine) parts.push(`operated by ${s.cruiseLine}`);
  if (s.shipClass) parts.push(`belonging to the ${s.shipClass} class`);
  if (s.yearBuilt) parts.push(`built in ${s.yearBuilt}`);
  if (s.builder) parts.push(`at ${s.builder}`);
  if (s.flagState) parts.push(`flagged in ${s.flagState}`);
  let line1 = parts.join(", ") + ".";

  const dims: string[] = [];
  if (s.lengthMeters) dims.push(`${s.lengthMeters} m length`);
  if (s.beamMeters) dims.push(`${s.beamMeters} m beam`);
  if (s.draftMeters) dims.push(`${s.draftMeters} m draft`);
  if (s.grossTonnage) dims.push(`${s.grossTonnage} GT`);
  const line2 = dims.length ? `Dimensions: ${dims.join(", ")}.` : "";

  const cap: string[] = [];
  if (s.passengerCapacity) cap.push(`${s.passengerCapacity} passengers`);
  if (s.crewCount) cap.push(`${s.crewCount} crew`);
  if (s.deckCount) cap.push(`${s.deckCount} decks`);
  if (s.cabinCount) cap.push(`${s.cabinCount} cabins`);
  const line3 = cap.length ? `Capacity: ${cap.join(", ")}.` : "";

  return [line1, line2, line3].filter(Boolean).join(" ");
}

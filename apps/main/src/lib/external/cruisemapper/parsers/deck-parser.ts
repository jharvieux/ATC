// BP37 §33.5 / §33.6 — CruiseMapper deck plan parser.
//
// Extracts structured deck data PLUS the image URLs for each deck view.
// Images are returned as URL strings only — the caller (image-asset
// recorder) validates the host allowlist and creates rag_media_assets
// rows. No image bytes ever touch this code.

import * as cheerio from "cheerio";

export interface ParsedDeckPlanImage {
  imageUrl: string;
  caption: string | null;
  width: number | null;
  height: number | null;
}

export interface ParsedDeckPlan {
  shipName: string;
  shipSlug: string;
  deckNumber: number | null;
  deckLabel: string;
  cabinNumberRanges: string[];   // e.g., ['9628–9658', '9660–9700']
  cabinCategories: string[];     // e.g., ['Interior (1T)', 'Balcony (3V, 6V)']
  publicVenues: string[];
  deckNotes: string | null;      // misc remark line if present
  images: ParsedDeckPlanImage[]; // hot-link candidates
  sourceUrl: string;
  text: string;                  // deterministic prose for RAG ingest
}

function num(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /(-?\d[\d,]*\.?\d*)/.exec(s);
  if (!m) return null;
  const v = parseFloat((m[1] ?? "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

function deckNumberFromText(label: string): number | null {
  const m = /\bdeck\s*(\d+)/i.exec(label);
  if (!m) return null;
  return parseInt(m[1] ?? "0", 10) || null;
}

function slugFromUrl(url: string): string {
  const u = new URL(url);
  const segs = u.pathname.split("/").filter(Boolean);
  // Deck plan URLs look like /ships/<ship-slug>-1234/deck-09 or similar.
  // Take the segment before the last `deck-NN`.
  const idx = segs.findIndex((s) => /^deck-\d+$/i.test(s));
  const shipSeg = idx > 0 ? segs[idx - 1] : segs[segs.length - 2] ?? "";
  return (shipSeg ?? "").replace(/\.html?$/i, "");
}

export function parseDeckPlanPage(html: string, sourceUrl: string): ParsedDeckPlan | null {
  const $ = cheerio.load(html);

  const h1 = $("h1").first().text().trim();
  if (!h1) return null;

  // Heuristic: h1 typically reads "Ship Name - Deck 9" or similar.
  const splitMatch = /^(.*?)\s*[-–|]\s*(deck\s*\d+.*)$/i.exec(h1);
  const shipName = ((splitMatch?.[1]) ?? h1).trim();
  const deckLabel = ((splitMatch?.[2]) ?? "").trim() || (h1.match(/deck\s*\d+.*/i)?.[0]?.trim() ?? "");

  const deckNumber = deckNumberFromText(deckLabel || h1);
  const shipSlug = slugFromUrl(sourceUrl);
  if (!shipSlug) return null;

  // Cabin number ranges: look for li/p text matching NNNN–NNNN or NNNN-NNNN.
  const cabinNumberRanges = new Set<string>();
  $("li, p, td").each((_, el) => {
    const t = $(el).text();
    for (const m of t.matchAll(/(\d{3,5})\s*[–-]\s*(\d{3,5})/g)) {
      cabinNumberRanges.add(`${m[1]}–${m[2]}`);
    }
  });

  // Cabin categories: a "Cabins" section often lists category names + codes.
  const cabinCategories: string[] = [];
  $(`h2, h3, h4`).filter((_, el) => /cabins?/i.test($(el).text())).first()
    .nextAll("ul").first().find("li").each((_, el) => {
      const t = $(el).text().trim();
      if (t) cabinCategories.push(t);
    });
  if (cabinCategories.length === 0) {
    // Fall back: scan text for category code patterns like "1T", "3V", "6V" in spec rows.
    $("li, td, p").each((_, el) => {
      const t = $(el).text();
      const m = /(Interior|Inside|Oceanview|Balcony|Suite|Mini[- ]Suite)\s*\(([^)]+)\)/i.exec(t);
      if (m) cabinCategories.push(`${m[1]} (${m[2]})`);
    });
  }

  // Public venues
  const publicVenues: string[] = [];
  $(`h2, h3, h4`).filter((_, el) => /venues?|public areas?/i.test($(el).text())).first()
    .nextAll("ul").first().find("li").each((_, el) => {
      const t = $(el).text().trim();
      if (t) publicVenues.push(t);
    });

  // Deck-level notes (e.g., "in-hull balconies")
  const deckNotes = $(`h2, h3, h4`).filter((_, el) => /notes?|deck info/i.test($(el).text())).first()
    .nextAll("p").first().text().trim() || null;

  // Image URLs — restricted to clearly deck-plan-ish image tags.
  const images: ParsedDeckPlanImage[] = [];
  const seen = new Set<string>();
  $("img").each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data-src");
    if (!src) return;
    let abs: string;
    try { abs = new URL(src, sourceUrl).toString(); } catch { return; }
    if (seen.has(abs)) return;
    seen.add(abs);

    // Skip likely-decorative thumbnails (small images).
    const w = num($(el).attr("width"));
    const h = num($(el).attr("height"));
    if (w !== null && w < 200) return;

    const caption = $(el).attr("alt")?.trim() || null;
    images.push({ imageUrl: abs, caption: caption ?? null, width: w, height: h });
  });

  // Sanity gate: name + (at least one cabin signal or at least one image)
  const haveSomething = !!(cabinNumberRanges.size > 0 || cabinCategories.length > 0 || images.length > 0);
  if (!haveSomething) return null;

  const text = renderDeckText({
    shipName, deckLabel, deckNumber,
    cabinNumberRanges: [...cabinNumberRanges].sort(),
    cabinCategories,
    publicVenues,
    deckNotes,
    imageCount: images.length,
  });

  return {
    shipName, shipSlug,
    deckNumber, deckLabel,
    cabinNumberRanges: [...cabinNumberRanges].sort(),
    cabinCategories,
    publicVenues,
    deckNotes,
    images,
    sourceUrl,
    text,
  };
}

function renderDeckText(d: {
  shipName: string; deckLabel: string; deckNumber: number | null;
  cabinNumberRanges: string[]; cabinCategories: string[]; publicVenues: string[];
  deckNotes: string | null; imageCount: number;
}): string {
  const header = d.deckNumber
    ? `${d.shipName} Deck ${d.deckNumber}${d.deckLabel && !/^deck\s*\d+$/i.test(d.deckLabel) ? ` (${d.deckLabel})` : ""}.`
    : `${d.shipName} ${d.deckLabel}.`;
  const parts: string[] = [header];
  if (d.cabinNumberRanges.length > 0) parts.push(`Cabin number ranges: ${d.cabinNumberRanges.join("; ")}.`);
  if (d.cabinCategories.length > 0) parts.push(`Cabin categories: ${d.cabinCategories.join("; ")}.`);
  if (d.publicVenues.length > 0)    parts.push(`Public venues: ${d.publicVenues.join(", ")}.`);
  if (d.deckNotes)                  parts.push(`Notes: ${d.deckNotes}`);
  if (d.imageCount > 0)             parts.push(`See referenced deck plan image${d.imageCount > 1 ? "s" : ""} for layout.`);
  return parts.join(" ");
}

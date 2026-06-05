// BP37 §33.5 / §33.6 — CruiseMapper deck plan parser.
//
// CruiseMapper publishes deck plans as ONE combined gallery page per ship
// at /deckplans/<Ship-Slug-Id>. That page links to a per-deck sub-page
// (/deckplans/<slug>/deckNN-id) and shows a thumbnail per deck; the full-size
// deck plan image is the thumbnail URL with the /thumbs/ segment removed.
//
// We ingest one deck_intel chunk per ship (deck list + labels) and record
// each deck's full-size image as a hot-linked asset. Images are returned as
// URL strings only — the caller (image-asset recorder) validates the host
// allowlist and creates rag_media_assets rows. No image bytes touch this code.

import * as cheerio from "cheerio";

const THUMB_SEGMENT = "/images/deckplans/thumbs/";

export interface ParsedDeckPlanImage {
  imageUrl: string;          // full-size deck plan image (thumbnail path, /thumbs/ stripped)
  caption: string | null;    // img alt/title, e.g. "Carnival Horizon Deck 01 - Riviera-Cabins"
  deckNumber: number | null;
  width: number | null;
  height: number | null;
}

export interface ParsedDeckEntry {
  deckNumber: number;
  label: string;             // e.g. "Riviera-Cabins" (empty when the alt has no label)
}

export interface ParsedDeckPlan {
  shipName: string;
  shipSlug: string;
  deckCount: number;
  decks: ParsedDeckEntry[];
  images: ParsedDeckPlanImage[];
  sourceUrl: string;
  text: string;              // deterministic prose for RAG ingest
}

function num(s: string | null | undefined): number | null {
  if (!s) return null;
  const v = parseInt(s.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(v) ? v : null;
}

function shipSlugFromUrl(url: string): string {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return ""; }
  const segs = pathname.split("/").filter(Boolean);
  const idx = segs.indexOf("deckplans");
  return idx >= 0 && segs[idx + 1] ? (segs[idx + 1] ?? "") : "";
}

function shipNameFromSlug(slug: string): string {
  return slug.replace(/-\d+$/, "").replace(/-/g, " ").trim();
}

// alt: "Carnival Horizon Deck 01 - Riviera-Cabins" → "Riviera-Cabins"
function labelFromAlt(alt: string): string {
  const m = /Deck\s+\d+\s*[-–|:]\s*(.+)$/i.exec(alt);
  return m ? (m[1] ?? "").trim() : "";
}

export function parseDeckPlanPage(html: string, sourceUrl: string): ParsedDeckPlan | null {
  const shipSlug = shipSlugFromUrl(sourceUrl);
  if (!shipSlug) return null;

  const $ = cheerio.load(html);

  const h1 = $("h1").first().text().trim();
  let shipName = h1.replace(/\s*deck\s*plans?\s*$/i, "").trim();

  // Per-deck sub-links on THIS ship's gallery look like
  // /deckplans/<shipSlug>/deckNN-id — scope to this ship so the page's
  // "Other <line> deckplans" cross-links can't leak in.
  const deckLinkPrefix = `/deckplans/${shipSlug.toLowerCase()}/deck`;

  const images: ParsedDeckPlanImage[] = [];
  const decks: ParsedDeckEntry[] = [];
  const seenImage = new Set<string>();
  const seenDeck = new Set<number>();

  $("img").each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data-src");
    if (!src) return;
    let abs: string;
    try { abs = new URL(src, sourceUrl).toString(); } catch { return; }
    if (!new URL(abs).pathname.includes(THUMB_SEGMENT)) return;

    // The deck thumb is wrapped in its per-deck link; that link's deck number
    // is the authoritative source (the alt text is a secondary signal).
    let deckPath = "";
    try { deckPath = new URL($(el).closest("a").attr("href") ?? "", sourceUrl).pathname; } catch { deckPath = ""; }
    if (!deckPath.toLowerCase().startsWith(deckLinkPrefix)) return;
    const m = /\/deck0*(\d+)-/i.exec(deckPath);
    const deckNumber = m ? num(m[1]) : null;
    if (deckNumber === null) return;

    const fullUrl = abs.replace(THUMB_SEGMENT, "/images/deckplans/");
    if (seenImage.has(fullUrl)) return;
    seenImage.add(fullUrl);

    const alt = ($(el).attr("alt") ?? $(el).attr("title") ?? "").trim();
    images.push({
      imageUrl: fullUrl,
      caption: alt || null,
      deckNumber,
      width: num($(el).attr("width")),
      height: num($(el).attr("height")),
    });

    if (!seenDeck.has(deckNumber)) {
      seenDeck.add(deckNumber);
      decks.push({ deckNumber, label: labelFromAlt(alt) });
    }
  });

  if (images.length === 0) return null;

  if (!shipName) {
    const firstAlt = images[0]?.caption ?? "";
    shipName = firstAlt.replace(/\s*Deck\s+\d+.*$/i, "").trim() || shipNameFromSlug(shipSlug);
  }

  decks.sort((a, b) => a.deckNumber - b.deckNumber);

  return {
    shipName,
    shipSlug,
    deckCount: decks.length,
    decks,
    images,
    sourceUrl,
    text: renderDeckText(shipName, decks, images.length),
  };
}

function renderDeckText(shipName: string, decks: ParsedDeckEntry[], imageCount: number): string {
  const parts: string[] = [`${shipName} deck plans — ${decks.length} deck${decks.length === 1 ? "" : "s"}.`];
  if (decks.length > 0) {
    const list = decks
      .map((d) => (d.label ? `Deck ${d.deckNumber}: ${d.label}` : `Deck ${d.deckNumber}`))
      .join("; ");
    parts.push(`${list}.`);
  }
  if (imageCount > 0) parts.push(`${imageCount} deck plan image${imageCount === 1 ? "" : "s"} available.`);
  return parts.join(" ");
}

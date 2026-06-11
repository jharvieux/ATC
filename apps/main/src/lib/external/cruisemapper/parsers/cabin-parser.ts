// §953 Phase A — CruiseMapper cabin category parser.
//
// CruiseMapper publishes one cabin overview page per ship at
// /cabins/<Ship-Slug-Id>. Each page has ~20 cabinItem blocks with:
//   - h3.contentTitle — cabin category name
//   - img.cabinPlan  — floor plan GIF (always present, absolute URL)
//   - table.cabinSpecTable — spec rows (max passengers, size, location, etc.)
//   - div.itemContent — prose description
//   - adjacent div.col-md-12:has(owl-carousel) — cabin photos (swipebox hrefs)
//
// We produce one cabin_intel chunk per ship and record each floor plan GIF +
// cabin photo as a hot-linked asset via the image-asset recorder. No image
// bytes touch this code.

import * as cheerio from "cheerio";

export interface ParsedCabinImage {
  imageUrl: string;
  caption: string | null;
  categoryName: string;
  imageType: "floor_plan" | "photo";
}

export interface ParsedCabinCategory {
  name: string;
  floorPlanUrl: string | null;
  specs: Record<string, string>;   // "Max passengers" → "8", etc.
  description: string | null;      // prose from div.itemContent, HTML stripped
  photoUrls: string[];             // full-size photo URLs from swipebox links
}

export interface ParsedCabinPage {
  shipName: string;
  shipSlug: string;
  categoryCount: number;
  categories: ParsedCabinCategory[];
  images: ParsedCabinImage[];      // floor plans + photos, flat list for recorder
  sourceUrl: string;
  text: string;                    // deterministic prose for RAG ingest
}

function shipSlugFromUrl(url: string): string {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return ""; }
  const segs = pathname.split("/").filter(Boolean);
  const idx = segs.indexOf("cabins");
  return idx >= 0 && segs[idx + 1] ? (segs[idx + 1] ?? "") : "";
}

function shipNameFromSlug(slug: string): string {
  return slug.replace(/-\d+$/, "").replace(/-/g, " ").trim();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&nbsp;/g, " ").trim();
}

export function parseCabinPage(html: string, sourceUrl: string): ParsedCabinPage | null {
  const shipSlug = shipSlugFromUrl(sourceUrl);
  if (!shipSlug) return null;

  const $ = cheerio.load(html);

  const h1 = $("h1.pageTitle").first().text().trim()
    || $("h1").first().text().trim();
  let shipName = h1.replace(/\s*cabins?\s+(and\s+suites?)?\s*$/i, "").trim();

  const categories: ParsedCabinCategory[] = [];
  const images: ParsedCabinImage[] = [];

  $("div.cabinItem").each((_, el) => {
    const $el = $(el);
    const name = $el.find("h3.contentTitle").first().text().trim();
    if (!name) return;

    // Floor plan GIF.
    const planSrc = $el.find("img.cabinPlan").first().attr("src");
    let floorPlanUrl: string | null = null;
    if (planSrc) {
      try { floorPlanUrl = new URL(planSrc, sourceUrl).toString(); } catch { /* skip */ }
    }

    // Spec table rows.
    const specs: Record<string, string> = {};
    $el.find("table.cabinSpecTable tr").each((_, row) => {
      const label = $(row).find("td.specLabelTechCol").first().text()
        .replace(/:$/, "").trim();
      const value = $(row).find("td").last().text().trim();
      if (label && value) specs[label] = value;
    });

    // Prose description (strip HTML; may contain inline images — text only).
    const descHtml = $el.find("div.itemContent").html() ?? "";
    const description = stripHtml(descHtml) || null;

    // Photos live in the immediately following sibling div that has an
    // owl-carousel inside. The swipebox href is the full-size image.
    const $nextSibling = $el.next("div");
    const photoUrls: string[] = [];
    if ($nextSibling.find("div.owl-carousel").length > 0) {
      $nextSibling.find("a.swipebox").each((_, a) => {
        const href = $(a).attr("href");
        if (!href) return;
        try { photoUrls.push(new URL(href, sourceUrl).toString()); } catch { /* skip */ }
      });
    }

    categories.push({ name, floorPlanUrl, specs, description, photoUrls });

    if (floorPlanUrl) {
      images.push({
        imageUrl: floorPlanUrl,
        caption: `${shipName} ${name} floor plan`,
        categoryName: name,
        imageType: "floor_plan",
      });
    }
    for (const photoUrl of photoUrls) {
      images.push({
        imageUrl: photoUrl,
        caption: `${shipName} ${name} photo`,
        categoryName: name,
        imageType: "photo",
      });
    }
  });

  if (categories.length === 0) return null;

  if (!shipName) shipName = shipNameFromSlug(shipSlug);

  return {
    shipName,
    shipSlug,
    categoryCount: categories.length,
    categories,
    images,
    sourceUrl,
    text: renderCabinText(shipName, categories),
  };
}

function renderCabinText(shipName: string, categories: ParsedCabinCategory[]): string {
  const parts: string[] = [
    `${shipName} cabin categories — ${categories.length} categor${categories.length === 1 ? "y" : "ies"}.`,
  ];
  for (const cat of categories) {
    const specParts: string[] = [];
    for (const [k, v] of Object.entries(cat.specs)) specParts.push(`${k}: ${v}`);
    const specStr = specParts.length > 0 ? ` ${specParts.join("; ")}.` : "";
    const descStr = cat.description ? ` ${cat.description}` : "";
    parts.push(`${cat.name}:${specStr}${descStr}`);
  }
  return parts.join(" ");
}

// §23.4 — Static catalog of destination hero images by cruise region.
//
// This module is the single source of truth for the per-region imagery
// the pre-cruise email templates render. The same rows are seeded into
// rag_media_assets (migration apps/rag/supabase/migrations/0019_...) so
// the RAG service can serve them by region for any future retrieval
// surface, but for email-send paths we read this constant directly to
// avoid a network call per email render.
//
// To override per-tenant: write a tenant-scoped row into
// rag_media_assets (scope='tenant', tenant_id=...) and switch the
// lookup function to query rag_media_assets when the operator surfaces
// a per-tenant override (not yet wired).
//
// To add a region:
//   1. Add a DestinationRegion enum value.
//   2. Add a DestinationImage entry below (or `null` if not yet sourced).
//   3. If the image will live in the RAG, add an INSERT to the next
//      rag_media_assets seed migration.
//
// LICENSING: each entry's attribution string MUST appear visibly when
// the image is rendered. Unsplash and Wikimedia Commons both require
// photographer/source credit; the template footer is where we surface
// it. See docs/runbooks/email-samples.md.

export type DestinationRegion =
  | "caribbean"
  | "alaska"
  | "mediterranean"
  | "northern_europe"
  | "mexican_riviera"
  | "hawaii"
  | "bermuda"
  | "bahamas"
  | "asia"
  | "south_pacific"
  | "transatlantic"
  | "other";

export interface DestinationImage {
  url: string;
  source_page_url: string;
  attribution: string;
  alt_text: string;
  width_px: number;
  height_px: number;
}

// All 12 regions sourced via web research. Templates handle a null lookup
// by omitting the hero image block (graceful degradation, not a failure).
const CATALOG: Record<DestinationRegion, DestinationImage | null> = {
  caribbean: {
    url: "https://images.unsplash.com/photo-1655299417498-52f3a304c2a4?w=1200&q=80&auto=format&fit=crop",
    source_page_url: "https://unsplash.com/photos/a-beach-with-palm-trees-and-blue-water-P41tKN3uZhw",
    attribution: "Photo by Christian Lendl on Unsplash",
    alt_text: "A Caribbean beach with palm trees and turquoise water",
    width_px: 1200,
    height_px: 800,
  },
  mediterranean: {
    url: "https://images.unsplash.com/photo-1696519669474-3001c0e2b548?w=1200&q=80&auto=format&fit=crop",
    source_page_url:
      "https://unsplash.com/photos/an-aerial-view-of-a-village-on-a-cliff-overlooking-the-ocean-7RaonO0Jn9E",
    attribution: "Photo by Dawid Tkocz on Unsplash",
    alt_text:
      "Aerial view of Santorini's white village on the cliffs overlooking the Aegean",
    width_px: 1200,
    height_px: 800,
  },
  northern_europe: {
    url: "https://images.unsplash.com/photo-1722446636397-e069a5849350?w=1200&q=80&auto=format&fit=crop",
    source_page_url:
      "https://unsplash.com/photos/a-cruise-ship-docked-in-a-bay-surrounded-by-mountains-47N8u-sYSBk",
    attribution: "Photo by Tom Donders on Unsplash",
    alt_text: "A cruise ship at anchor in Geirangerfjord, Norway",
    width_px: 1200,
    height_px: 800,
  },
  alaska: {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Hubbard_Glacier_calving_Alaska._%2812027161386%29.jpg/1200px-Hubbard_Glacier_calving_Alaska._%2812027161386%29.jpg",
    source_page_url:
      "https://commons.wikimedia.org/wiki/File:Hubbard_Glacier_calving_Alaska._(12027161386).jpg",
    attribution: "Photo by Doug Knuth / Wikimedia Commons (CC BY-SA 2.0)",
    alt_text: "Hubbard Glacier calving in Disenchantment Bay, Alaska",
    width_px: 1200,
    height_px: 800,
  },
  mexican_riviera: {
    url: "https://images.unsplash.com/photo-1527734055665-8def83921139?w=1200&q=80&auto=format&fit=crop",
    source_page_url: "https://unsplash.com/photos/QsP5UmrFPlw",
    attribution: "Photo by Victor Hughes on Unsplash",
    alt_text: "Aerial view of Cabo San Lucas, Mexico with the rocky arch and harbor",
    width_px: 1200,
    height_px: 800,
  },
  hawaii: {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/NaPali_Coast_from_Pride_of_America.JPG/1200px-NaPali_Coast_from_Pride_of_America.JPG",
    source_page_url: "https://commons.wikimedia.org/wiki/File:NaPali_Coast_from_Pride_of_America.JPG",
    attribution: "Photo by Rwminix / Wikimedia Commons (CC BY-SA 3.0)",
    alt_text: "Na Pali Coast, Kauai, Hawaii — rugged green sea cliffs viewed from the ocean",
    width_px: 1200,
    height_px: 800,
  },
  bermuda: {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Horseshoebay.Bermuda.JPG/1200px-Horseshoebay.Bermuda.JPG",
    source_page_url: "https://commons.wikimedia.org/wiki/File:Horseshoebay.Bermuda.JPG",
    attribution: "Photo by Ekem / Wikimedia Commons (CC BY-SA 3.0)",
    alt_text: "Horseshoe Bay beach in Bermuda with pink sand and turquoise water",
    width_px: 1200,
    height_px: 800,
  },
  bahamas: {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/03/Goat_Cay%2C_Exuma%2C_The_Bahamas.jpg/1200px-Goat_Cay%2C_Exuma%2C_The_Bahamas.jpg",
    source_page_url: "https://commons.wikimedia.org/wiki/File:Goat_Cay,_Exuma,_The_Bahamas.jpg",
    attribution: "Photo by DrGvago / Wikimedia Commons (CC BY-SA 4.0)",
    alt_text: "Turquoise waters of Goat Cay, Exuma, The Bahamas",
    width_px: 1200,
    height_px: 800,
  },
  asia: {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/Merlion_and_the_Singapore_Skyline_at_Night.JPG/1200px-Merlion_and_the_Singapore_Skyline_at_Night.JPG",
    source_page_url: "https://commons.wikimedia.org/wiki/File:Merlion_and_the_Singapore_Skyline_at_Night.JPG",
    attribution: "Photo by Merlion444 / Wikimedia Commons (CC0)",
    alt_text: "Singapore skyline at night with the iconic Merlion fountain",
    width_px: 1200,
    height_px: 800,
  },
  south_pacific: {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Bora_Bora_%2816542797633%29.jpg/1200px-Bora_Bora_%2816542797633%29.jpg",
    source_page_url: "https://commons.wikimedia.org/wiki/File:Bora_Bora_(16542797633).jpg",
    attribution: "Photo by The TerraMar Project / Wikimedia Commons (CC BY 2.0)",
    alt_text: "Bora Bora's turquoise lagoon and volcanic peak, French Polynesia",
    width_px: 1200,
    height_px: 800,
  },
  transatlantic: {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/P%26O_Cruises_Oceana_01.JPG/1200px-P%26O_Cruises_Oceana_01.JPG",
    source_page_url: "https://commons.wikimedia.org/wiki/File:P%26O_Cruises_Oceana_01.JPG",
    attribution: "Photo by Piergiuliano Chesi / Wikimedia Commons (CC BY 3.0)",
    alt_text: "P&O Cruises ocean liner underway at sea",
    width_px: 1200,
    height_px: 800,
  },
  other: {
    url: "https://images.unsplash.com/photo-1691315755851-7307bcb5e892?w=1200&q=80&auto=format&fit=crop",
    source_page_url: "https://unsplash.com/photos/a-view-of-a-harbor-with-boats-in-the-water-948iKHyc3UI",
    attribution: "Photo by Philip Myrtorp on Unsplash",
    alt_text: "Scenic harbor view with boats in Monaco",
    width_px: 1200,
    height_px: 800,
  },
};

export function getDestinationImage(
  region: DestinationRegion,
): DestinationImage | null {
  return CATALOG[region];
}

// Used by tests + a future admin coverage view: shows which regions
// have imagery and which still need it.
export function listRegionImageCoverage(): Array<{
  region: DestinationRegion;
  has_image: boolean;
}> {
  return (Object.keys(CATALOG) as DestinationRegion[]).map((region) => ({
    region,
    has_image: CATALOG[region] !== null,
  }));
}

// §23.4 — destination-images catalog invariants.
//
// These tests pin: every DestinationRegion enum value has an entry
// (even if null), populated entries have all attribution fields, and
// the coverage helper accurately reports which regions still need
// imagery. Catches drift between the type and the runtime catalog —
// a future contributor who adds a region to the enum without a catalog
// entry will fail here rather than at email-render time.

import { describe, it, expect } from "vitest";
import {
  getDestinationImage,
  listRegionImageCoverage,
} from "@/lib/cruise-regions/destination-images";

const ALL_REGIONS = [
  "caribbean", "alaska", "mediterranean", "northern_europe",
  "mexican_riviera", "hawaii", "bermuda", "bahamas",
  "asia", "south_pacific", "transatlantic", "other",
] as const;

describe("destination-images catalog", () => {
  // TypeScript already enforces that every DestinationRegion key exists
  // in the CATALOG (the Record type). This test catches the related but
  // distinct runtime regression: listRegionImageCoverage walks the
  // CATALOG via Object.keys and must produce a coverage row for every
  // region. A future change that filters the coverage list (e.g. "only
  // return populated entries") would pass typecheck but fail here.
  it("listRegionImageCoverage produces one row per region in the type union", () => {
    const coverage = listRegionImageCoverage();
    const seen = new Set(coverage.map((c) => c.region));
    for (const region of ALL_REGIONS) {
      expect(seen.has(region)).toBe(true);
    }
    expect(coverage).toHaveLength(ALL_REGIONS.length);
  });

  it("populated entries have all attribution fields filled (license compliance)", () => {
    for (const region of ALL_REGIONS) {
      const entry = getDestinationImage(region);
      if (entry === null) continue;
      // License compliance: every image must carry attribution + source page.
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.source_page_url).toMatch(/^https:\/\//);
      expect(entry.attribution.length).toBeGreaterThan(0);
      expect(entry.alt_text.length).toBeGreaterThan(0);
      expect(entry.width_px).toBeGreaterThan(0);
      expect(entry.height_px).toBeGreaterThan(0);
    }
  });

  it("all 12 regions have populated entries (#487 completes full catalog)", () => {
    // #487 sourced the remaining 8 regions. Every region now has an image.
    // If anyone removes a sourced image, this test forces a conversation.
    for (const region of ALL_REGIONS) {
      expect(getDestinationImage(region)).not.toBeNull();
    }
  });

  it("listRegionImageCoverage reports has_image accurately", () => {
    const coverage = listRegionImageCoverage();
    for (const row of coverage) {
      expect(row.has_image).toBe(true);
    }
  });
});

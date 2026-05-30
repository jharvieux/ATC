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
  it("every region in the type union has a catalog entry (null or populated)", () => {
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

  it("the four seeded regions have populated entries (pinned baseline)", () => {
    // If anyone removes a sourced image, this test forces a conversation
    // about whether the catalog is regressing.
    expect(getDestinationImage("caribbean")).not.toBeNull();
    expect(getDestinationImage("mediterranean")).not.toBeNull();
    expect(getDestinationImage("northern_europe")).not.toBeNull();
    expect(getDestinationImage("alaska")).not.toBeNull();
  });

  it("listRegionImageCoverage reports has_image accurately", () => {
    const coverage = listRegionImageCoverage();
    const caribbean = coverage.find((c) => c.region === "caribbean");
    const hawaii = coverage.find((c) => c.region === "hawaii");
    expect(caribbean?.has_image).toBe(true);
    expect(hawaii?.has_image).toBe(false); // not yet sourced
  });
});

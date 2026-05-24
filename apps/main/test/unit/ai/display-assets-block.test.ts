// BP39 §33.7.1 — DISPLAYABLE ASSETS prompt block builder tests.

import { describe, expect, it } from "vitest";
import { buildDisplayableAssetsBlock } from "../../../src/lib/ai/display-assets-block";
import type { RetrievedAsset } from "../../../src/lib/rag/chunk-types";

function asset(over: Partial<RetrievedAsset> = {}): RetrievedAsset {
  return {
    asset_id: "11111111-1111-4111-8111-111111111111",
    kind: "deck_plan",
    entity_type: "deck",
    entity_id: "symphony-deck-09",
    image_url: "https://www.cruisemapper.com/x.jpg",
    source_page_url: "https://www.cruisemapper.com/ships/symphony/deck-09",
    attribution: "Image: CruiseMapper",
    caption: "Deck 9 overview",
    width_px: 800,
    height_px: 600,
    ...over,
  };
}

describe("buildDisplayableAssetsBlock", () => {
  it("returns empty string when no assets provided", () => {
    expect(buildDisplayableAssetsBlock([])).toBe("");
  });

  it("renders DISPLAYABLE ASSETS header + entries + DISPLAY INSTRUCTIONS", () => {
    const block = buildDisplayableAssetsBlock([asset()]);
    expect(block).toContain("DISPLAYABLE ASSETS");
    expect(block).toContain("DISPLAY INSTRUCTIONS");
    expect(block).toContain("11111111-1111-4111-8111-111111111111");
    expect(block).toContain("Deck 9 overview");
  });

  it("falls back to '(no caption)' when caption is null", () => {
    const block = buildDisplayableAssetsBlock([asset({ caption: null })]);
    expect(block).toContain("(no caption)");
  });

  it("renders multiple assets each on its own line", () => {
    const block = buildDisplayableAssetsBlock([
      asset({ asset_id: "11111111-1111-4111-8111-111111111111", caption: "First" }),
      asset({ asset_id: "22222222-2222-4222-8222-222222222222", caption: "Second" }),
    ]);
    const lines = block.split("\n").filter((l) => l.startsWith("- id:"));
    expect(lines).toHaveLength(2);
  });

  it("instructs sparing use (at most 3 per reply)", () => {
    const block = buildDisplayableAssetsBlock([asset()]);
    expect(block).toContain("at most 3");
  });

  it("sanitizes caption newlines so the entry stays one line", () => {
    const block = buildDisplayableAssetsBlock([asset({ caption: "Line1\nLine2\rLine3" })]);
    const lines = block.split("\n").filter((l) => l.includes("11111111"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Line1 Line2 Line3");
  });
});

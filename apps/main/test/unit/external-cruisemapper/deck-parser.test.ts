// BP37 §33.6 — deck-parser unit tests.
//
// Fixture markup is captured verbatim from the live combined gallery page
// https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355 (issue #768):
// each deck is a thumbnail wrapped in its per-deck sub-link, and the full-size
// image is the thumb URL with /thumbs/ removed. The trailing "Other ...
// deckplans" cross-link uses a real deckplans thumb but points at a DIFFERENT
// ship — it must NOT leak into this ship's decks.

import { describe, expect, it } from "vitest";
import { parseDeckPlanPage } from "../../../src/lib/external/cruisemapper/parsers/deck-parser";

const SOURCE_URL = "https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355";

const FIXTURE_GALLERY = `
<!doctype html><html><body>
<h1>Carnival Horizon deck plans</h1>
<div class="deckplans">
  <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355/deck01-3956" ><img loading="lazy" src="https://www.cruisemapper.com/images/deckplans/thumbs/1355a0a74af575c.gif" alt="Carnival Horizon Deck 01 - Riviera-Cabins" title="Carnival Horizon Deck 01 - Riviera-Cabins" /></a>
  <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355/deck01-3956">Deck 01</a>

  <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355/deck02-3957" ><img loading="lazy" src="https://www.cruisemapper.com/images/deckplans/thumbs/1355fa5791693cd.gif" alt="Carnival Horizon Deck 02 - Main-Cabins-Family Harbor" title="Carnival Horizon Deck 02 - Main-Cabins-Family Harbor" /></a>
  <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355/deck02-3957">Deck 02</a>

  <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355/deck12-3967" ><img loading="lazy" src="https://www.cruisemapper.com/images/deckplans/thumbs/13550d45f9cf492.gif" alt="Carnival Horizon Deck 12 - Spa-Cabins-Sports-WaterWorks" title="Carnival Horizon Deck 12 - Spa-Cabins-Sports-WaterWorks" /></a>
  <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355/deck12-3967">Deck 12</a>

  <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355/deck14-3969" ><img loading="lazy" src="https://www.cruisemapper.com/images/deckplans/thumbs/135538c5ce2a0e3.gif" alt="Carnival Horizon Deck 14 - Cabins-SkyRide-SkyCourse" title="Carnival Horizon Deck 14 - Cabins-SkyRide-SkyCourse" /></a>
  <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355/deck14-3969">Deck 14</a>
</div>
<h2>Other Carnival Cruise Line deckplans</h2>
<div class="other">
  <a href="https://www.cruisemapper.com/deckplans/Carnival-Vista-1356/deck05-9999" ><img loading="lazy" src="https://www.cruisemapper.com/images/deckplans/thumbs/1356deadbeef000.gif" alt="Carnival Vista Deck 05 - Lido" title="Carnival Vista Deck 05 - Lido" /></a>
</div>
</body></html>
`;

describe("parseDeckPlanPage — combined gallery page", () => {
  it("parses ship name, deck list, and full-size images", () => {
    const p = parseDeckPlanPage(FIXTURE_GALLERY, SOURCE_URL);
    expect(p).not.toBeNull();
    if (!p) return;

    expect(p.shipName).toBe("Carnival Horizon");
    expect(p.shipSlug).toBe("Carnival-Horizon-1355");

    // Four decks from THIS ship (01, 02, 12, 14); deck 13 absent as on the
    // real ship — no fabricated gaps.
    expect(p.deckCount).toBe(4);
    expect(p.decks.map((d) => d.deckNumber)).toEqual([1, 2, 12, 14]);
    expect(p.decks.find((d) => d.deckNumber === 1)?.label).toBe("Riviera-Cabins");
    expect(p.decks.find((d) => d.deckNumber === 12)?.label).toBe("Spa-Cabins-Sports-WaterWorks");
    expect(p.decks.find((d) => d.deckNumber === 14)?.label).toBe("Cabins-SkyRide-SkyCourse");
  });

  it("derives the full-size image URL by stripping /thumbs/", () => {
    const p = parseDeckPlanPage(FIXTURE_GALLERY, SOURCE_URL)!;
    expect(p.images).toHaveLength(4);
    expect(p.images[0]!.imageUrl).toBe("https://www.cruisemapper.com/images/deckplans/1355a0a74af575c.gif");
    expect(p.images[0]!.deckNumber).toBe(1);
    expect(p.images.every((i) => !i.imageUrl.includes("/thumbs/"))).toBe(true);
    // gif is the real deck-plan format — the recorder must accept it.
    expect(p.images.every((i) => i.imageUrl.endsWith(".gif"))).toBe(true);
  });

  it("excludes decks cross-linked from the 'Other ... deckplans' section", () => {
    const p = parseDeckPlanPage(FIXTURE_GALLERY, SOURCE_URL)!;
    // The Carnival Vista deck-05 cross-link uses a real deckplans thumb but a
    // different ship slug — it must not leak in.
    expect(p.decks.some((d) => d.deckNumber === 5)).toBe(false);
    expect(p.images.some((i) => i.imageUrl.includes("1356deadbeef"))).toBe(false);
  });

  it("produces deterministic text listing every deck with its label", () => {
    const a = parseDeckPlanPage(FIXTURE_GALLERY, SOURCE_URL)!.text;
    const b = parseDeckPlanPage(FIXTURE_GALLERY, SOURCE_URL)!.text;
    expect(a).toBe(b);
    expect(a).toContain("Carnival Horizon deck plans — 4 decks.");
    expect(a).toContain("Deck 12: Spa-Cabins-Sports-WaterWorks");
    expect(a).toContain("4 deck plan images available.");
  });

  it("returns null when the page has no deck-plan thumbnails", () => {
    expect(parseDeckPlanPage("<html><body><h1>Nope deck plans</h1></body></html>", SOURCE_URL)).toBeNull();
  });

  it("returns null when the URL is not a /deckplans/<slug> page", () => {
    expect(parseDeckPlanPage(FIXTURE_GALLERY, "https://www.cruisemapper.com/ships/Carnival-Horizon-1355")).toBeNull();
  });
});

// When CruiseMapper 301-redirects a renamed ship (e.g. Pacific-Princess-589 →
// Azamara-Onward-589), the diy-fetcher follows the redirect silently and
// returns body from the destination page. The deck link prefix check uses the
// sourceUrl slug, so passing the original URL produces no matches → null.
// refresh-cruisemapper-static.ts must pass fetched.finalUrl for deck plans (#819).
describe("parseDeckPlanPage — redirect scenario (renamed ship)", () => {
  const REDIRECTED_SHIP_URL = "https://www.cruisemapper.com/deckplans/Azamara-Onward-589";
  const STALE_ORIGINAL_URL  = "https://www.cruisemapper.com/deckplans/Pacific-Princess-589";

  const REDIRECT_FIXTURE = `
<!doctype html><html><body>
<h1>Azamara Onward deck plans</h1>
<div class="deckplans">
  <a href="https://www.cruisemapper.com/deckplans/Azamara-Onward-589/deck05-8001"><img loading="lazy" src="https://www.cruisemapper.com/images/deckplans/thumbs/589aa1234567890.gif" alt="Azamara Onward Deck 05 - Staterooms" /></a>
  <a href="https://www.cruisemapper.com/deckplans/Azamara-Onward-589/deck06-8002"><img loading="lazy" src="https://www.cruisemapper.com/images/deckplans/thumbs/589bb9876543210.gif" alt="Azamara Onward Deck 06 - Club Ocean" /></a>
</div>
</body></html>
`;

  it("parses correctly when given the final (post-redirect) URL as sourceUrl", () => {
    const p = parseDeckPlanPage(REDIRECT_FIXTURE, REDIRECTED_SHIP_URL);
    expect(p).not.toBeNull();
    expect(p!.shipSlug).toBe("Azamara-Onward-589");
    expect(p!.deckCount).toBe(2);
  });

  it("returns null when given the stale pre-redirect URL as sourceUrl", () => {
    expect(parseDeckPlanPage(REDIRECT_FIXTURE, STALE_ORIGINAL_URL)).toBeNull();
  });
});

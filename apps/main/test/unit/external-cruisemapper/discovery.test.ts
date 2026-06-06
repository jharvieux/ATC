// Issue #694 — discovery URL-shape filter.
//
// The original `startsWith(pathPrefix)` check incorrectly matched siblings
// like `/ports-in-arctic-and-antarctica-10` for prefix `/ports`. The fix
// requires `/` after the prefix so only true detail URLs survive.

import { describe, expect, it } from "vitest";
import { extractDetailUrls, extractDeckPlanLinks, extractFleetShipUrls } from "../../../src/lib/external/cruisemapper/discovery";

const BASE = "https://www.cruisemapper.com";

describe("extractDetailUrls — URL shape filter", () => {
  it("keeps /ports/<slug>-<id> detail URLs", () => {
    const html = `
      <html><body>
        <a href="https://www.cruisemapper.com/ports/istanbul-port-71">Istanbul</a>
        <a href="/ports/miami-port-123">Miami</a>
        <a href="https://www.cruisemapper.com/ports/southampton-port-9">Southampton</a>
      </body></html>
    `;
    const urls = extractDetailUrls(html, BASE, "/ports");
    expect(urls).toHaveLength(3);
    expect(urls).toContain("https://www.cruisemapper.com/ports/istanbul-port-71");
    expect(urls).toContain("https://www.cruisemapper.com/ports/miami-port-123");
    expect(urls).toContain("https://www.cruisemapper.com/ports/southampton-port-9");
  });

  it("drops /ports-in-<region>-<id> listing URLs (this is the #694 bug)", () => {
    const html = `
      <html><body>
        <a href="/ports-in-arctic-and-antarctica-10">Arctic Region</a>
        <a href="/ports-in-mediterranean-and-black-sea-4">Mediterranean</a>
        <a href="/ports-in-caribbean-7">Caribbean</a>
        <a href="/ports/istanbul-port-71">Istanbul (detail)</a>
      </body></html>
    `;
    const urls = extractDetailUrls(html, BASE, "/ports");
    // Only the detail URL survives.
    expect(urls).toEqual(["https://www.cruisemapper.com/ports/istanbul-port-71"]);
  });

  it("drops the index page itself (the prefix without a slug)", () => {
    const html = `
      <html><body>
        <a href="/ports">Index</a>
        <a href="/ports/">Index slashed</a>
        <a href="/ports/oslo-port-44">Oslo</a>
      </body></html>
    `;
    const urls = extractDetailUrls(html, BASE, "/ports");
    expect(urls).toEqual(["https://www.cruisemapper.com/ports/oslo-port-44"]);
  });

  it("strips fragments and query strings for canonical inventory keys", () => {
    const html = `
      <html><body>
        <a href="/ports/oslo-port-44?from=index#schedule">Oslo with extras</a>
      </body></html>
    `;
    const urls = extractDetailUrls(html, BASE, "/ports");
    expect(urls).toEqual(["https://www.cruisemapper.com/ports/oslo-port-44"]);
  });

  it("does not follow off-host links", () => {
    const html = `
      <html><body>
        <a href="https://example.com/ports/spoof-1">External</a>
        <a href="/ports/oslo-port-44">Internal</a>
      </body></html>
    `;
    const urls = extractDetailUrls(html, BASE, "/ports");
    expect(urls).toEqual(["https://www.cruisemapper.com/ports/oslo-port-44"]);
  });

  it("ships filter is unaffected (no /ships-in-* shape exists)", () => {
    const html = `
      <html><body>
        <a href="/ships/Norwegian-Prima-2216">Norwegian Prima</a>
        <a href="/ships/Utopia-Of-The-Seas-2180">Utopia</a>
      </body></html>
    `;
    const urls = extractDetailUrls(html, BASE, "/ships");
    expect(urls).toHaveLength(2);
    expect(urls).toContain("https://www.cruisemapper.com/ships/Norwegian-Prima-2216");
  });
});

describe("extractDeckPlanLinks — combined gallery URL filter (#768)", () => {
  const SHIP_URL = "https://www.cruisemapper.com/ships/Carnival-Horizon-1355";

  it("keeps the /deckplans/<slug> combined gallery link (absolute + relative dedup)", () => {
    const html = `
      <html><body>
        <a href="https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355">Deck plans</a>
        <a href="/deckplans/Carnival-Horizon-1355">Deck plans</a>
      </body></html>
    `;
    expect(extractDeckPlanLinks(html, SHIP_URL)).toEqual([
      "https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355",
    ]);
  });

  it("drops the bare /deckplans index and the per-deck sub-pages", () => {
    const html = `
      <html><body>
        <a href="/deckplans">All deck plans</a>
        <a href="/deckplans/Carnival-Horizon-1355">Gallery</a>
        <a href="/deckplans/Carnival-Horizon-1355/deck01-3956">Deck 01</a>
        <a href="/deckplans/Carnival-Horizon-1355/deck12-3967">Deck 12</a>
      </body></html>
    `;
    expect(extractDeckPlanLinks(html, SHIP_URL)).toEqual([
      "https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355",
    ]);
  });

  it("strips fragments + query strings and ignores off-host links", () => {
    const html = `
      <html><body>
        <a href="https://example.com/deckplans/Spoof-1">External</a>
        <a href="/deckplans/Carnival-Horizon-1355?from=ship#decks">Gallery</a>
      </body></html>
    `;
    expect(extractDeckPlanLinks(html, SHIP_URL)).toEqual([
      "https://www.cruisemapper.com/deckplans/Carnival-Horizon-1355",
    ]);
  });

  it("returns nothing when the ship page has no deck-plans link", () => {
    const html = `<html><body><a href="/ships/Carnival-Horizon-1355">Ship</a></body></html>`;
    expect(extractDeckPlanLinks(html, SHIP_URL)).toEqual([]);
  });
});

// Captured-shape fixture from a real cruise-line page (/cruise-lines/...): the
// fleet is in `.shipListItem` cards inside `.shipList.lineItemRelationsList`,
// while the page also embeds a global ship browser whose links must NOT leak
// into the line's fleet (the original 38-ship coverage bug).
const LINE_PAGE = `
<!doctype html><html><body>
<h2>Carnival Cruise Line fleet</h2>
<ul class="shipList lineItemRelationsList">
  <li class="col-sm-6"><div class="shipListItem">
    <a href="https://www.cruisemapper.com/ships/Carnival-Breeze-703">Carnival Breeze</a>
    <div class="shipListItemButtons shipListItemButtons-4">
      <a class="btnOrange shipListItemButton" href="/ships/Carnival-Breeze-703?tab=review#review">Review</a>
      <a class="btnBlue shipListItemButton" href="/ships/Carnival-Breeze-703?#itinerary">Itinerary</a>
    </div>
  </div></li>
  <li class="col-sm-6"><div class="shipListItem">
    <a href="/ships/Carnival-Celebration-2106">Carnival Celebration</a>
  </div></li>
</ul>
<div class="otherShipsBrowser">
  <a href="/ships/Adora-Mediterranea-719">Adora (global browser — exclude)</a>
  <a href="https://example.com/ships/Spoof-1">off-host (exclude)</a>
</div>
</body></html>
`;

describe("extractFleetShipUrls — cruise-line fleet scoping", () => {
  it("extracts only the line's fleet (.shipListItem cards), not the global browser", () => {
    expect(extractFleetShipUrls(LINE_PAGE, BASE)).toEqual([
      "https://www.cruisemapper.com/ships/Carnival-Breeze-703",
      "https://www.cruisemapper.com/ships/Carnival-Celebration-2106",
    ]);
  });

  it("dedups a ship's main + button links to one canonical URL, stripping query/fragment", () => {
    const urls = extractFleetShipUrls(LINE_PAGE, BASE);
    // Carnival Breeze appears 3x (main + review + itinerary) — one entry.
    expect(urls.filter((u) => u.includes("Carnival-Breeze"))).toHaveLength(1);
    expect(urls.every((u) => !u.includes("?") && !u.includes("#"))).toBe(true);
  });

  it("excludes global-browser links (outside .shipListItem) and off-host links", () => {
    const urls = extractFleetShipUrls(LINE_PAGE, BASE);
    expect(urls.some((u) => u.includes("/ships/Adora"))).toBe(false);
    // Compare the parsed host, not a substring (a bare `.includes("example.com")`
    // trips CodeQL js/incomplete-url-substring-sanitization — the same lazy
    // host check that extractFleetShipUrls deliberately avoids).
    expect(urls.some((u) => new URL(u).host === "example.com")).toBe(false);
  });
});

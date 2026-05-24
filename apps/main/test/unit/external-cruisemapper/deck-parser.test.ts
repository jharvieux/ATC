// BP37 §33.6 — deck-parser unit tests.

import { describe, expect, it } from "vitest";
import { parseDeckPlanPage } from "../../../src/lib/external/cruisemapper/parsers/deck-parser";

const FIXTURE_DECK = `
<!doctype html><html><body>
<h1>Symphony of the Seas - Deck 9</h1>
<h2>Cabins</h2>
<ul>
  <li>Interior (1T)</li>
  <li>Oceanview (2N)</li>
  <li>Balcony (3V, 6V)</li>
</ul>
<p>Cabin numbers 9628–9658, 9660–9700.</p>
<h2>Public venues</h2>
<ul>
  <li>Sky Bar</li>
  <li>Library</li>
</ul>
<h2>Deck info</h2>
<p>Some decks include in-hull balconies.</p>
<img src="https://www.cruisemapper.com/images/deck-9-overview.jpg" alt="Deck 9 overview" width="800" height="600" />
<img src="/images/deck-9-bow.png" alt="Deck 9 bow" width="600" height="400" />
<img src="https://www.cruisemapper.com/thumbs/tiny.jpg" width="80" height="60" />
</body></html>
`;

describe("parseDeckPlanPage", () => {
  it("parses full deck plan page", () => {
    const p = parseDeckPlanPage(FIXTURE_DECK, "https://www.cruisemapper.com/ships/symphony-of-the-seas-1234/deck-09");
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.shipName).toContain("Symphony of the Seas");
    expect(p.shipSlug).toBe("symphony-of-the-seas-1234");
    expect(p.deckNumber).toBe(9);
    expect(p.cabinNumberRanges).toContain("9628–9658");
    expect(p.cabinCategories.length).toBeGreaterThan(0);
    expect(p.publicVenues).toContain("Sky Bar");
    expect(p.deckNotes).toContain("in-hull");
    // Two large images recorded; the 80px thumb filtered out.
    expect(p.images.length).toBe(2);
    expect(p.images[0]!.imageUrl).toContain("/deck-9-overview.jpg");
    expect(p.images[1]!.imageUrl).toContain("/images/deck-9-bow.png");
    expect(p.text).toContain("Symphony of the Seas");
    expect(p.text).toContain("9628");
  });

  it("returns null when page is empty", () => {
    expect(parseDeckPlanPage("<html><body></body></html>", "https://x.test/y/deck-1")).toBeNull();
  });

  it("text is deterministic for same input", () => {
    const a = parseDeckPlanPage(FIXTURE_DECK, "https://x.test/y/deck-1")!.text;
    const b = parseDeckPlanPage(FIXTURE_DECK, "https://x.test/y/deck-1")!.text;
    expect(a).toBe(b);
  });
});

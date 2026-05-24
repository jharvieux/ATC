// BP36 §33.5 — ship-parser unit tests with representative fixture HTML.

import { describe, expect, it } from "vitest";
import { parseShipPage } from "../../../src/lib/external/cruisemapper/parsers/ship-parser";

const FIXTURE_SHIP = `
<!doctype html><html><body>
<h1>Symphony of the Seas</h1>
<table>
  <tr><th>Cruise line</th><td>Royal Caribbean</td></tr>
  <tr><th>Year built</th><td>2018</td></tr>
  <tr><th>Builder</th><td>STX France</td></tr>
  <tr><th>Class</th><td>Oasis</td></tr>
  <tr><th>Flag</th><td>The Bahamas</td></tr>
  <tr><th>Length</th><td>362 m</td></tr>
  <tr><th>Beam</th><td>66 m</td></tr>
  <tr><th>Draft</th><td>9 m</td></tr>
  <tr><th>GT</th><td>228,081</td></tr>
  <tr><th>Passengers</th><td>5,518</td></tr>
  <tr><th>Crew</th><td>2,200</td></tr>
  <tr><th>Decks</th><td>18</td></tr>
  <tr><th>Cabins</th><td>2,759</td></tr>
</table>
</body></html>
`;

const FIXTURE_DT_DD = `
<!doctype html><html><body>
<h1>Sample Ship</h1>
<dl>
  <dt>Cruise line</dt><dd>Norwegian</dd>
  <dt>Year built</dt><dd>2019</dd>
  <dt>Class</dt><dd>Encore</dd>
  <dt>Flag</dt><dd>Bahamas</dd>
  <dt>Length</dt><dd>333 m</dd>
  <dt>Beam</dt><dd>41 m</dd>
  <dt>GT</dt><dd>169,116</dd>
  <dt>Passengers</dt><dd>3,998</dd>
  <dt>Crew</dt><dd>1,733</dd>
</dl>
</body></html>
`;

describe("parseShipPage", () => {
  it("parses a full <th><td> spec table", () => {
    const p = parseShipPage(FIXTURE_SHIP, "https://www.cruisemapper.com/ships/symphony-of-the-seas-1234");
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.shipName).toBe("Symphony of the Seas");
    expect(p.cruiseLine).toBe("Royal Caribbean");
    expect(p.yearBuilt).toBe(2018);
    expect(p.shipClass).toBe("Oasis");
    expect(p.grossTonnage).toBe(228081);
    expect(p.passengerCapacity).toBe(5518);
    expect(p.shipSlug).toBe("symphony-of-the-seas-1234");
    expect(p.text).toContain("Symphony of the Seas");
    expect(p.text).toContain("Royal Caribbean");
    expect(p.text).toContain("228081");
  });

  it("parses a <dt><dd> spec layout fallback", () => {
    const p = parseShipPage(FIXTURE_DT_DD, "https://www.cruisemapper.com/ships/sample-ship-9999");
    expect(p).not.toBeNull();
    expect(p!.cruiseLine).toBe("Norwegian");
    expect(p!.grossTonnage).toBe(169116);
  });

  it("returns null when shape is unrecognized (no h1, no specs)", () => {
    expect(parseShipPage("<html><body><p>nope</p></body></html>", "https://x.test/y")).toBeNull();
  });

  it("returns null when most fields are missing (page layout drift signal)", () => {
    const sparse = `<html><body><h1>Mystery Ship</h1><p>just prose, no spec</p></body></html>`;
    expect(parseShipPage(sparse, "https://x.test/y")).toBeNull();
  });

  it("produces byte-deterministic text for same input (content-hash idempotency)", () => {
    const a = parseShipPage(FIXTURE_SHIP, "https://x.test/y")!.text;
    const b = parseShipPage(FIXTURE_SHIP, "https://x.test/y")!.text;
    expect(a).toBe(b);
  });
});

// BP36 §33.5 — port-parser unit tests.

import { describe, expect, it } from "vitest";
import { parsePortPage } from "../../../src/lib/external/cruisemapper/parsers/port-parser";

const FIXTURE_PORT = `
<!doctype html><html><body>
<h1>Miami</h1>
<table>
  <tr><th>Country</th><td>United States</td></tr>
  <tr><th>Region</th><td>Caribbean</td></tr>
</table>
<h2>Terminal</h2>
<p>PortMiami operates seven cruise terminals along Dodge Island.</p>
<h2>Transit</h2>
<p>Reachable from Miami International Airport by taxi (~15 min) or by Metromover.</p>
<h2>Nearby attractions</h2>
<ul>
  <li>Bayside Marketplace</li>
  <li>Art Deco Historic District</li>
  <li>South Beach</li>
</ul>
</body></html>
`;

describe("parsePortPage", () => {
  it("parses full port page", () => {
    const p = parsePortPage(FIXTURE_PORT, "https://www.cruisemapper.com/ports/miami-123");
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.portName).toBe("Miami");
    expect(p.country).toBe("United States");
    expect(p.region).toBe("Caribbean");
    expect(p.terminalInfo).toContain("PortMiami");
    expect(p.transitNotes).toContain("Metromover");
    expect(p.nearbyAttractions).toEqual([
      "Bayside Marketplace",
      "Art Deco Historic District",
      "South Beach",
    ]);
    expect(p.portSlug).toBe("miami-123");
    expect(p.text).toContain("Miami is a cruise port");
    expect(p.text).toContain("Caribbean");
    expect(p.text).toContain("South Beach");
  });

  it("returns null when nothing useful is parseable", () => {
    expect(parsePortPage("<html><body></body></html>", "https://x.test/y")).toBeNull();
  });

  it("returns deterministic text", () => {
    const a = parsePortPage(FIXTURE_PORT, "https://x.test/y")!.text;
    const b = parsePortPage(FIXTURE_PORT, "https://x.test/y")!.text;
    expect(a).toBe(b);
  });
});

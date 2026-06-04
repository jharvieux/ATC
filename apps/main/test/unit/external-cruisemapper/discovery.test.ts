// Issue #694 — discovery URL-shape filter.
//
// The original `startsWith(pathPrefix)` check incorrectly matched siblings
// like `/ports-in-arctic-and-antarctica-10` for prefix `/ports`. The fix
// requires `/` after the prefix so only true detail URLs survive.

import { describe, expect, it } from "vitest";
import { extractDetailUrls } from "../../../src/lib/external/cruisemapper/discovery";

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

// §953 Phase A — cabin-parser unit tests.
//
// Fixture markup is captured verbatim from the live combined cabin page
// https://www.cruisemapper.com/cabins/Norwegian-Prima-2216 (issue #953):
// each cabinItem block has a floor-plan img and spec table; most also have
// an adjacent owl-carousel gallery with swipebox photo links.
// The trailing "Other Norwegian Cruise Line cabins" aside MUST NOT leak
// any images or categories into this ship's result.

import { describe, expect, it } from "vitest";
import { parseCabinPage } from "../../../src/lib/external/cruisemapper/parsers/cabin-parser";

const SOURCE_URL = "https://www.cruisemapper.com/cabins/Norwegian-Prima-2216";

// Two cabin items with galleries + one without photos + Other-ships section.
// Condensed verbatim from the live page (2026-06-10).
const FIXTURE_HTML = `
<!doctype html><html><body>
<h1 class="pageTitle">Norwegian Prima cabins and suites</h1>
<div class="row">

<div class="col-md-12 cabinItem"><h3 class="contentTitle">3-Bedroom The Haven Premier Owner Suite with Balcony Jacuzzi</h3><h4>Layout (floor plan)</h4><img class="img-responsive cabinPlan" src="https://www.cruisemapper.com/images/cabins/2216c841be4f85b.gif" alt="Norwegian Prima 3-Bedroom The Haven Premier Owner Suite with Balcony Jacuzzi  floor plan" loading="lazy"><table class="table table-striped cabinSpecTable"><tr><td class="specLabelTechCol">Max passengers:</td><td>8</td></tr><tr><td class="specLabelTechCol">Staterooms number:</td><td>2</td></tr><tr><td class="specLabelTechCol">Cabin size:</td><td>2100 ft2 / 195 m2</td></tr><tr><td class="specLabelTechCol">Balcony size:</td><td>830 ft2 / 77 m2</td></tr><tr><td class="specLabelTechCol">Location (on decks):</td><td>aft on deck 14</td></tr><tr><td class="specLabelTechCol">Type (categories):</td><td>(H2) The Haven Premier Owner's Suite with Large Balcony</td></tr></table><div class="itemContent"><p>The Haven Premier Owner Suite features an aft-facing wraparound balcony (with Jacuzzi), 3 bedrooms, 3 bathrooms.</p></div></div>
<div class="col-md-12"><div class="owl-carousel" id="cabinGallery5043"><div class="item"><a class="swipebox" href="https://www.cruisemapper.com/images/cabins/pictures/2216C-5043-90c314a.jpg" title=""><img loading="lazy" src="https://www.cruisemapper.com/images/cabins/pictures/thumb/2216C-5043-90c314a.jpg" alt="photo"/></a></div><div class="item"><a class="swipebox" href="https://www.cruisemapper.com/images/cabins/pictures/2216C-5043-93f7275.jpg" title=""><img loading="lazy" src="https://www.cruisemapper.com/images/cabins/pictures/thumb/2216C-5043-93f7275.jpg" alt="photo"/></a></div></div></div>

<div class="col-md-12 cabinItem"><h3 class="contentTitle">The Haven Deluxe Owner Suite</h3><h4>Layout (floor plan)</h4><img class="img-responsive cabinPlan" src="https://www.cruisemapper.com/images/cabins/22160f5c86e7d22.gif" alt="Norwegian Prima The Haven Deluxe Owner Suite  floor plan" loading="lazy"><table class="table table-striped cabinSpecTable"><tr><td class="specLabelTechCol">Max passengers:</td><td>6</td></tr><tr><td class="specLabelTechCol">Staterooms number:</td><td>4</td></tr><tr><td class="specLabelTechCol">Cabin size:</td><td>1605-1750 ft2 / 149-163 m2</td></tr><tr><td class="specLabelTechCol">Balcony size:</td><td>615-730 ft2 / 57-68 m2</td></tr><tr><td class="specLabelTechCol">Location (on decks):</td><td>aft on decks 13-15</td></tr><tr><td class="specLabelTechCol">Type (categories):</td><td>(H3) The Haven Deluxe Owner's Suite with Large Balcony</td></tr></table><div class="itemContent"><p>The Haven Deluxe Owner Suite features an aft-facing balcony (with Jacuzzi), 2 bedrooms, 2 bathrooms.</p></div></div>
<div class="col-md-12"><div class="owl-carousel" id="cabinGallery5044"><div class="item"><a class="swipebox" href="https://www.cruisemapper.com/images/cabins/pictures/2216C-5044-6cf5a44.jpg" title=""><img loading="lazy" src="https://www.cruisemapper.com/images/cabins/pictures/thumb/2216C-5044-6cf5a44.jpg" alt="photo"/></a></div></div></div>

<div class="col-md-12 cabinItem"><h3 class="contentTitle">Studio Interior Single Cabin</h3><h4>Layout (floor plan)</h4><img class="img-responsive cabinPlan" src="https://www.cruisemapper.com/images/cabins/2216d602de62b46.gif" alt="Norwegian Prima Studio Interior Single Cabin  floor plan" loading="lazy"><table class="table table-striped cabinSpecTable"><tr><td class="specLabelTechCol">Max passengers:</td><td>1</td></tr><tr><td class="specLabelTechCol">Staterooms number:</td><td>73</td></tr><tr><td class="specLabelTechCol">Cabin size:</td><td>95 ft2 / 9 m2</td></tr><tr><td class="specLabelTechCol">Balcony size:</td><td>none</td></tr><tr><td class="specLabelTechCol">Location (on decks):</td><td>forward on decks 12-13</td></tr><tr><td class="specLabelTechCol">Type (categories):</td><td>(T1) Studio / Interior Single Cabin</td></tr></table><div class="itemContent"><p>Each Studio is fitted with a full-size bed.</p></div></div>

</div>
<section class="asideList"><header><h3>Other Norwegian Cruise Line cabins</h3></header><ul>
  <li><a href="https://www.cruisemapper.com/cabins/Pride-of-America-594">Pride of America</a></li>
</ul></section>
</body></html>
`;

describe("parseCabinPage — Norwegian Prima fixture", () => {
  it("parses ship name, slug, and category count", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.shipName).toBe("Norwegian Prima");
    expect(p.shipSlug).toBe("Norwegian-Prima-2216");
    expect(p.categoryCount).toBe(3);
    expect(p.categories).toHaveLength(3);
  });

  it("parses category name and floor plan URL for first category", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!;
    const cat = p.categories[0]!;
    expect(cat.name).toBe("3-Bedroom The Haven Premier Owner Suite with Balcony Jacuzzi");
    expect(cat.floorPlanUrl).toBe("https://www.cruisemapper.com/images/cabins/2216c841be4f85b.gif");
  });

  it("parses spec table into key-value pairs", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!;
    const specs = p.categories[0]!.specs;
    expect(specs["Max passengers"]).toBe("8");
    expect(specs["Cabin size"]).toBe("2100 ft2 / 195 m2");
    expect(specs["Balcony size"]).toBe("830 ft2 / 77 m2");
    expect(specs["Location (on decks)"]).toBe("aft on deck 14");
    expect(specs["Type (categories)"]).toBe("(H2) The Haven Premier Owner's Suite with Large Balcony");
  });

  it("parses prose description, stripping HTML", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!;
    const desc = p.categories[0]!.description;
    expect(desc).not.toBeNull();
    expect(desc).toContain("wraparound balcony");
    expect(desc).not.toContain("<p>");
    expect(desc).not.toContain("<span");
  });

  it("associates adjacent gallery photos with the preceding cabin category", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!;
    // First category has 2 photos.
    expect(p.categories[0]!.photoUrls).toHaveLength(2);
    expect(p.categories[0]!.photoUrls[0]).toBe(
      "https://www.cruisemapper.com/images/cabins/pictures/2216C-5043-90c314a.jpg"
    );
    expect(p.categories[0]!.photoUrls[1]).toBe(
      "https://www.cruisemapper.com/images/cabins/pictures/2216C-5043-93f7275.jpg"
    );
    // Second category has 1 photo.
    expect(p.categories[1]!.photoUrls).toHaveLength(1);
  });

  it("handles categories with no gallery (no photos)", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!;
    // Studio cabin has no adjacent owl-carousel.
    const studio = p.categories.find((c) => c.name === "Studio Interior Single Cabin");
    expect(studio).toBeDefined();
    expect(studio!.photoUrls).toHaveLength(0);
  });

  it("builds a flat images list covering floor plans and photos", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!;
    const floorPlans = p.images.filter((i) => i.imageType === "floor_plan");
    const photos = p.images.filter((i) => i.imageType === "photo");
    // 3 cabin items → 3 floor plans.
    expect(floorPlans).toHaveLength(3);
    // 2 + 1 + 0 photos.
    expect(photos).toHaveLength(3);
    // Floor plan URLs are the direct .gif paths (not thumbs).
    expect(floorPlans.every((i) => i.imageUrl.endsWith(".gif"))).toBe(true);
    // Photo URLs are full-size (no /thumb/ segment).
    expect(photos.every((i) => !i.imageUrl.includes("/thumb/"))).toBe(true);
  });

  it("sets imageType and categoryName correctly on images", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!;
    const fp = p.images.find((i) => i.imageType === "floor_plan" && i.categoryName === "The Haven Deluxe Owner Suite");
    expect(fp).toBeDefined();
    expect(fp!.imageUrl).toBe("https://www.cruisemapper.com/images/cabins/22160f5c86e7d22.gif");
  });

  it("produces deterministic text mentioning ship name, category count, and key specs", () => {
    const a = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!.text;
    const b = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!.text;
    expect(a).toBe(b);
    expect(a).toContain("Norwegian Prima cabin categories — 3 categories.");
    expect(a).toContain("3-Bedroom The Haven Premier Owner Suite with Balcony Jacuzzi:");
    expect(a).toContain("Cabin size: 2100 ft2 / 195 m2");
    expect(a).toContain("Studio Interior Single Cabin:");
  });

  it("does not leak cabin data from the 'Other ... cabins' aside section", () => {
    const p = parseCabinPage(FIXTURE_HTML, SOURCE_URL)!;
    expect(p.categories.some((c) => c.name.includes("Pride of America"))).toBe(false);
  });

  it("returns null when the page has no cabinItem blocks", () => {
    expect(parseCabinPage("<html><body><h1>Nope</h1></body></html>", SOURCE_URL)).toBeNull();
  });

  it("returns null when the URL is not a /cabins/<slug> page", () => {
    expect(
      parseCabinPage(FIXTURE_HTML, "https://www.cruisemapper.com/ships/Norwegian-Prima-2216")
    ).toBeNull();
  });
});

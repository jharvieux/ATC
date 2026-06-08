// D-188 follow-up — AssetLightbox renders display assets in an on-page modal
// instead of a new-tab hyperlink, so customers aren't navigated to cruisemapper.com.
//
// AssetImage (the modal body) is tested directly because DialogContent renders
// null while closed — the <img> never appears in a closed-state static render of
// AssetLightbox, so the image-url wiring is covered here at the body level.

import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetImage, AssetLightbox } from "../../../src/components/chat/AssetLightbox";
import type { DisplayAsset } from "../../../src/components/chat/renderMessageContent";

const A: DisplayAsset = {
  asset_id: "11111111-1111-4111-8111-111111111111",
  kind: "deck_plan",
  image_url: "https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454.jpg",
  source_page_url: "https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454",
  attribution: "Image: CruiseMapper",
  caption: "The Haven",
};

describe("AssetImage (modal body)", () => {
  it("renders the hot-linked image with caption as alt + attribution", () => {
    const out = renderToStaticMarkup(<AssetImage asset={A} label="View deck plan" />);
    expect(out).toContain('src="https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454.jpg"');
    expect(out).toContain('alt="The Haven"');
    expect(out).toContain("Image: CruiseMapper");
  });

  it("falls back to the label as alt text when caption is null", () => {
    const out = renderToStaticMarkup(<AssetImage asset={{ ...A, caption: null }} label="View deck plan" />);
    expect(out).toContain('alt="View deck plan"');
  });

  it("escapes attribution + caption (no innerHTML / attribute injection)", () => {
    const xss: DisplayAsset = { ...A, attribution: "<script>a</script>", caption: '"><img onerror=x>' };
    const out = renderToStaticMarkup(<AssetImage asset={xss} label="L" />);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    // caption flows into the alt attribute; the injection string must not appear raw.
    expect(out).not.toContain("<img onerror");
  });
});

describe("AssetLightbox (closed state)", () => {
  it("renders a trigger + inline attribution, no image until opened (lazy load)", () => {
    const out = renderToStaticMarkup(<AssetLightbox asset={A} />);
    expect(out).toContain("View deck plan");
    expect(out).toContain("<button");
    expect(out).toContain("(Image: CruiseMapper)");
    // Closed dialog → image is NOT loaded until the user clicks (stays cheap),
    // and there is no new-tab navigation.
    expect(out).not.toContain("src=\"https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454.jpg\"");
    expect(out).not.toContain('target="_blank"');
  });
});

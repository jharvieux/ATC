// D-189/D-190 — AssetLightbox renders display assets in an on-page modal with a
// descriptive, caption-derived trigger label (e.g. "Norwegian Bliss Deck 17")
// instead of a generic "View deck plan".
//
// AssetImage (the modal body) is tested directly because DialogContent renders
// null while closed — the <img> never appears in a closed-state static render of
// AssetLightbox, so the image-url wiring is covered here at the body level.

import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetImage, AssetLightbox, assetLinkLabel } from "../../../src/components/chat/AssetLightbox";
import { Dialog, DialogContent } from "../../../src/components/ui/dialog";
import type { DisplayAsset } from "../../../src/components/chat/renderMessageContent";

const A: DisplayAsset = {
  asset_id: "11111111-1111-4111-8111-111111111111",
  kind: "deck_plan",
  image_url: "https://www.cruisemapper.com/images/deckplans/145471aaf27c508.gif",
  source_page_url: "https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454",
  attribution: "Image: CruiseMapper",
  caption: "Norwegian Bliss Deck 17 - Cabins-The Haven Lower-Sundeck-Teens",
};

describe("assetLinkLabel", () => {
  it("uses the caption prefix before ' - ' as a concise descriptive name", () => {
    expect(assetLinkLabel(A)).toBe("Norwegian Bliss Deck 17");
  });

  it("uses the whole caption when there is no ' - ' separator", () => {
    expect(assetLinkLabel({ ...A, caption: "The Haven" })).toBe("The Haven");
  });

  it("falls back to 'View {kind}' when caption is null", () => {
    expect(assetLinkLabel({ ...A, caption: null })).toBe("View deck plan");
  });

  it("falls back to 'View {kind}' when caption is blank", () => {
    expect(assetLinkLabel({ ...A, caption: "   " })).toBe("View deck plan");
  });
});

describe("AssetImage (modal body)", () => {
  it("renders the hot-linked image with caption as alt + the title + attribution", () => {
    const out = renderToStaticMarkup(<AssetImage asset={A} title={A.caption!} />);
    expect(out).toContain('src="https://www.cruisemapper.com/images/deckplans/145471aaf27c508.gif"');
    expect(out).toContain("Norwegian Bliss Deck 17 - Cabins-The Haven Lower-Sundeck-Teens"); // alt + title
    expect(out).toContain("Image: CruiseMapper");
  });

  it("caps the image height so it scales to fit the viewport (mobile)", () => {
    const out = renderToStaticMarkup(<AssetImage asset={A} title="t" />);
    expect(out).toContain("max-h-[75vh]");
    expect(out).toContain("max-w-full");
  });

  it("falls back to the title as alt text when caption is null", () => {
    const out = renderToStaticMarkup(<AssetImage asset={{ ...A, caption: null }} title="Deck plan" />);
    expect(out).toContain('alt="Deck plan"');
  });

  it("escapes attribution + caption (no innerHTML / attribute injection)", () => {
    const xss: DisplayAsset = { ...A, attribution: "<script>a</script>", caption: '"><img onerror=x>' };
    const out = renderToStaticMarkup(<AssetImage asset={xss} title="L" />);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<img onerror");
  });
});

describe("DialogContent (mobile cap — keeps the close ✕ on-screen)", () => {
  it("caps the panel at the viewport and scrolls so tall content can't push ✕ off-screen", () => {
    // Force the dialog open via the controlled `open` prop so the panel renders.
    const out = renderToStaticMarkup(
      <Dialog open={true}>
        <DialogContent>
          <div>tall content</div>
        </DialogContent>
      </Dialog>,
    );
    expect(out).toContain("max-h-[90vh]");
    expect(out).toContain("overflow-y-auto");
    expect(out).toContain('aria-label="Close dialog"'); // ✕ present
  });
});

describe("AssetLightbox (closed state)", () => {
  it("renders the descriptive trigger + inline attribution, no image until opened", () => {
    const out = renderToStaticMarkup(<AssetLightbox asset={A} />);
    expect(out).toContain("Norwegian Bliss Deck 17"); // caption-derived, not "View deck plan"
    expect(out).toContain("<button");
    expect(out).toContain("(Image: CruiseMapper)");
    // Closed dialog → image not loaded until the user clicks; no new-tab nav.
    expect(out).not.toContain("145471aaf27c508.gif");
    expect(out).not.toContain('target="_blank"');
  });
});

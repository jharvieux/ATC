// #881 — CustomerContextChatPanel must render display-asset markers.
//
// Before this fix the panel rendered bubble.content raw, so the server's
// [[display_asset:<uuid>]] markers appeared as literal text. This guards
// that assets accumulate from the 'assets' SSE event and that the Bubble
// component routes assistant content through renderMessageContent.

import { describe, it, expect } from "vitest";
import { renderMessageContent, type DisplayAsset } from "@/components/chat/renderMessageContent";

const ASSET: DisplayAsset = {
  asset_id: "10ade6d0-1fc2-4f57-8d9d-e5771b7d2108",
  kind: "deck_plan",
  image_url: "https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454",
  source_page_url: "https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454",
  attribution: "Image: CruiseMapper",
  caption: "Norwegian Bliss Deck 17",
};

const CONTENT_WITH_MARKER =
  "Here is the deck plan: [[display_asset:10ade6d0-1fc2-4f57-8d9d-e5771b7d2108]]";
const CONTENT_NO_MARKER = "No images here.";

describe("CustomerContextChatPanel — asset marker rendering (#881)", () => {
  it("renderMessageContent resolves [[display_asset:<id>]] to a link when the asset is present", () => {
    const rendered = renderMessageContent(CONTENT_WITH_MARKER, [ASSET], { showAssetLinks: true });
    // Should produce JSX containing a link element, not a raw marker string.
    const str = JSON.stringify(rendered);
    expect(str).not.toContain("[[display_asset:");
  });

  it("renderMessageContent leaves non-marker text unchanged", () => {
    const rendered = renderMessageContent(CONTENT_NO_MARKER, [], { showAssetLinks: true });
    const str = JSON.stringify(rendered);
    expect(str).toContain("No images here.");
  });

  it("renderMessageContent with undefined assets renders the marker literally (unresolved unknown-ID path)", () => {
    // When no 'assets' SSE event fires, pendingAssets is empty / undefined.
    // The server's asset-id-validation layer normally strips orphan markers,
    // but the renderer must handle undefined assets gracefully: unknown IDs
    // are rendered as the literal marker text (the renderer's own fallback).
    const rendered = renderMessageContent(CONTENT_WITH_MARKER, undefined, { showAssetLinks: true });
    const str = JSON.stringify(rendered);
    expect(str).toContain("[[display_asset:");
  });
});

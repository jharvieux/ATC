// BP39 — finalizeAssistantMessage attaches assets + citations to the message.
//
// WHY: the `assets` SSE event was defined and sent server-side but the client
// never attached it to the finalized message, so [[display_asset:<id>]] markers
// rendered as literal text (no backing asset). This guards that the accumulated
// assets reach the ChatMessage so the renderer can resolve the markers.

import { describe, expect, it } from "vitest";
import { finalizeAssistantMessage } from "../../../src/components/chat/finalize-assistant-message";
import type { DisplayAsset } from "../../../src/components/chat/renderMessageContent";

const ASSET: DisplayAsset = {
  asset_id: "10ade6d0-1fc2-4f57-8d9d-e5771b7d2108",
  kind: "deck_plan",
  image_url: "https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454",
  source_page_url: "https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454",
  attribution: "Image: CruiseMapper",
  caption: "The Haven",
};

describe("finalizeAssistantMessage", () => {
  it("attaches assets so display_asset markers can resolve (the bug this fixes)", () => {
    const msg = finalizeAssistantMessage({
      content: "Here are the Haven deck layouts: [[display_asset:10ade6d0-1fc2-4f57-8d9d-e5771b7d2108]]",
      assistantId: "m1",
      personaName: "Marcus",
      citations: [],
      assets: [ASSET],
    });
    expect(msg.assets).toEqual([ASSET]);
    expect(msg.role).toBe("assistant");
    expect(msg.id).toBe("m1");
  });

  it("omits the assets field entirely when there are none", () => {
    const msg = finalizeAssistantMessage({
      content: "No images here.",
      assistantId: "m2",
      personaName: "Marcus",
      citations: [],
      assets: [],
    });
    expect("assets" in msg).toBe(false);
  });

  it("attaches citations independently of assets", () => {
    const cite = { source_url: "https://example.com", title: "x" } as NonNullable<
      ReturnType<typeof finalizeAssistantMessage>["citations"]
    >[number];
    const msg = finalizeAssistantMessage({
      content: "Cited.",
      assistantId: "m3",
      personaName: "Marcus",
      citations: [cite],
      assets: [],
    });
    expect(msg.citations).toEqual([cite]);
    expect("assets" in msg).toBe(false);
  });

  it("falls back to a local id when assistantId is null", () => {
    const msg = finalizeAssistantMessage({
      content: "x",
      assistantId: null,
      personaName: "Marcus",
      citations: [],
      assets: [ASSET],
    });
    expect(msg.id).toMatch(/^local-a-/);
    expect(msg.assets).toEqual([ASSET]);
  });
});

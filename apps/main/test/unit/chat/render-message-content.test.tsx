// BP39 §33.7.2 — renderMessageContent unit tests.
//
// Pure-function output checked via react-dom/server → HTML string.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMessageContent, type DisplayAsset } from "../../../src/components/chat/renderMessageContent";

const A_ID = "11111111-1111-4111-8111-111111111111";
const B_ID = "22222222-2222-4222-8222-222222222222";

const A: DisplayAsset = {
  asset_id: A_ID,
  kind: "deck_plan",
  image_url: "https://www.cruisemapper.com/x.jpg",
  source_page_url: "https://www.cruisemapper.com/p",
  attribution: "Image: CruiseMapper",
  caption: "Deck 9",
};

function html(node: React.ReactNode): string {
  return renderToStaticMarkup(node as React.ReactElement);
}

describe("renderMessageContent", () => {
  it("returns plain content when no markup is present", () => {
    const out = html(renderMessageContent("Hello world", [A]));
    expect(out).toContain("Hello world");
    expect(out).not.toContain("display_asset");
    expect(out).not.toContain("href");
  });

  it("renders a known asset marker as a hyperlink with attribution", () => {
    const out = html(renderMessageContent(`See: [[display_asset:${A_ID}]]`, [A]));
    expect(out).toContain('href="https://www.cruisemapper.com/x.jpg"');
    expect(out).toContain("View deck plan");
    expect(out).toContain("Image: CruiseMapper");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain("display_asset:");
  });

  it("renders unknown UUIDs literally (defense-in-depth past asset validation)", () => {
    const out = html(renderMessageContent(`See: [[display_asset:${B_ID}]]`, [A]));
    expect(out).toContain(`[[display_asset:${B_ID}]]`);
    expect(out).not.toContain("href");
  });

  it("renders multiple markers in one message", () => {
    const B: DisplayAsset = { ...A, asset_id: B_ID, image_url: "https://www.cruisemapper.com/y.jpg" };
    const out = html(renderMessageContent(`A [[display_asset:${A_ID}]] then B [[display_asset:${B_ID}]]`, [A, B]));
    expect(out).toContain('href="https://www.cruisemapper.com/x.jpg"');
    expect(out).toContain('href="https://www.cruisemapper.com/y.jpg"');
  });

  it("escapes attribution text (no innerHTML injection)", () => {
    const xss: DisplayAsset = { ...A, attribution: "<script>alert(1)</script>" };
    const out = html(renderMessageContent(`x [[display_asset:${A_ID}]]`, [xss]));
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes the literal-fallback markup so unknown IDs can't smuggle html", () => {
    const out = html(renderMessageContent("[[display_asset:<img src=x>]]", [A]));
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("<img");
  });

  it("returns plain content when assets is undefined", () => {
    const out = html(renderMessageContent(`Hi [[display_asset:${A_ID}]]`, undefined));
    // Unknown asset → renders literal markup
    expect(out).toContain(`[[display_asset:${A_ID}]]`);
  });

  it("case-insensitive UUID matching", () => {
    const out = html(renderMessageContent(`X [[display_asset:${A_ID.toUpperCase()}]]`, [A]));
    expect(out).toContain('href="https://www.cruisemapper.com/x.jpg"');
  });

  it("strips all markup when showAssetLinks is false (source-display toggle off)", () => {
    const out = html(
      renderMessageContent(
        `Look at this  [[display_asset:${A_ID}]]  it's great.`,
        [A],
        { showAssetLinks: false },
      ),
    );
    expect(out).not.toContain("href");
    expect(out).not.toContain("display_asset");
    expect(out).not.toContain("View deck plan");
    expect(out).toContain("Look at this");
    expect(out).toContain("it&#x27;s great");
    expect(out).not.toMatch(/  /);
  });

  it("strips even unknown / malformed markup when showAssetLinks is false", () => {
    const out = html(
      renderMessageContent(`A [[display_asset:not-a-uuid]] B`, [A], { showAssetLinks: false }),
    );
    expect(out).not.toContain("display_asset");
  });

  it("showAssetLinks=true is the default", () => {
    const out = html(renderMessageContent(`X [[display_asset:${A_ID}]]`, [A]));
    expect(out).toContain("href=");
  });
});

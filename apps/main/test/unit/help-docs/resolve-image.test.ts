// #1688 — the PDF/Word export worker runs in Inngest with no browser
// origin, so a relative `/help/...` markdown img src can't resolve itself
// the way it would in the admin print view. Pins that resolveHelpImage
// reads the file straight off `public/help` on disk, and that a missing
// or unsupported src degrades to null instead of throwing (so one bad
// image ref can't take down the whole export).

import { describe, it, expect } from "vitest";
import { resolveHelpImage, pngDimensions } from "@/lib/help-docs/resolve-image";

const FIXTURE_SRC = "/help/test-fixtures/red-rect.png";

describe("resolveHelpImage (#1688)", () => {
  it("reads a real help-doc image off disk", () => {
    const resolved = resolveHelpImage(FIXTURE_SRC);
    expect(resolved).not.toBeNull();
    expect(resolved?.type).toBe("png");
    expect(resolved?.data.length).toBeGreaterThan(0);
  });

  it("returns null for a src that doesn't exist on disk", () => {
    expect(resolveHelpImage("/help/images/does-not-exist.png")).toBeNull();
  });

  it("returns null for a non-image extension", () => {
    expect(resolveHelpImage("/help/test-fixtures/red-rect.svg")).toBeNull();
  });

  it("returns null for a src that isn't rooted at /", () => {
    expect(resolveHelpImage("help/test-fixtures/red-rect.png")).toBeNull();
  });
});

describe("pngDimensions (#1688)", () => {
  it("parses width/height from the fixture PNG's IHDR chunk", () => {
    const resolved = resolveHelpImage(FIXTURE_SRC);
    const dims = pngDimensions(resolved!.data);
    expect(dims).toEqual({ width: 40, height: 20 });
  });

  it("returns null for non-PNG data", () => {
    expect(pngDimensions(Buffer.from("not a png"))).toBeNull();
  });
});

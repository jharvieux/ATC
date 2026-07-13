// #1688 — before this fix, `![alt](/help/...)` markdown images fell
// through to the default "paragraph line" branch in the PDF's markdown
// parser and were printed as literal `![alt](...)` text instead of being
// embedded, because the exporter never resolves relative img srcs (it
// runs in an Inngest worker with no browser origin). Pins that a help
// doc containing an image markdown line produces a real embedded image
// XObject in the output PDF, and that the raw markdown syntax never
// leaks into the rendered text.

import { describe, it, expect } from "vitest";
import { renderHelpDocsPdf } from "@/lib/help-docs/help-docs-pdf";
import { extractPdfText } from "@/lib/pdf/extract-pdf-text";
import type { HelpDoc } from "@/lib/help-ai/docs-loader";

const FIXTURE_DOC: HelpDoc = {
  slug: "image-fixture",
  title: "Image fixture doc",
  order: 1,
  category: "test",
  file_name: "image-fixture.md",
  tiers: [],
  body_markdown:
    "# Image fixture doc\n\nSome text before the image.\n\n" +
    "![a red rectangle](/help/test-fixtures/red-rect.png)\n\n" +
    "Some text after the image.\n",
};

describe("renderHelpDocsPdf image embedding (#1688)", () => {
  it("embeds a real image XObject for a resolvable markdown image ref", async () => {
    const pdfBuffer = await renderHelpDocsPdf({ docs: [FIXTURE_DOC] });
    const pdfBytes = pdfBuffer.toString("latin1");

    // react-pdf writes image XObjects with a literal, uncompressed
    // `/Subtype /Image` dictionary entry even though the pixel stream
    // itself is compressed — this is the same marker every PDF viewer
    // uses to find embedded images.
    expect(pdfBytes).toContain("/Subtype /Image");
  });

  it("does not leak the raw markdown image syntax into the text layer", async () => {
    const pdfBuffer = await renderHelpDocsPdf({ docs: [FIXTURE_DOC] });
    const text = await extractPdfText(new Uint8Array(pdfBuffer));

    expect(text).not.toContain("![a red rectangle]");
    expect(text).not.toContain("/help/test-fixtures/red-rect.png");
    expect(text).toContain("Some text before the image.");
    expect(text).toContain("Some text after the image.");
  });

  it("skips a missing image without throwing, and doesn't print its raw syntax", async () => {
    const docWithMissingImage: HelpDoc = {
      ...FIXTURE_DOC,
      body_markdown:
        "# Image fixture doc\n\n![missing](/help/images/not-backfilled-yet.png)\n\nStill here.\n",
    };
    const pdfBuffer = await renderHelpDocsPdf({ docs: [docWithMissingImage] });
    const text = await extractPdfText(new Uint8Array(pdfBuffer));

    expect(text).not.toContain("![missing]");
    expect(text).not.toContain("/help/images/not-backfilled-yet.png");
    expect(text).toContain("Still here.");
  });
});

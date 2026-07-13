// #1688 — before this fix, `![alt](/help/...)` markdown images fell
// through to the default "plain Paragraph" branch in the DOCX converter
// and were written out as literal `![alt](...)` text instead of being
// embedded, because the exporter never resolves relative img srcs (it
// runs in an Inngest worker with no browser origin). Pins that a doc
// containing an image markdown line produces a real embedded image in
// the .docx, and that the raw markdown syntax never leaks into a text
// run. Uses mammoth (already a project dep, used elsewhere to read
// customer-uploaded .docx files) to read the export back the way a real
// consumer would — a stronger signal than scanning the zip bytes, since
// document.xml is DEFLATE-compressed inside the archive.

import { describe, it, expect } from "vitest";
import { Document, Packer } from "docx";
import mammoth from "mammoth";
import { markdownToParagraphs } from "@/inngest/help-docs-docx-generate";

async function packToBuffer(md: string): Promise<Buffer> {
  const paragraphs = markdownToParagraphs(md);
  const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
  return Packer.toBuffer(doc);
}

describe("markdownToParagraphs image embedding (#1688)", () => {
  it("embeds a real, readable image for a resolvable markdown image ref", async () => {
    const md =
      "# Image fixture doc\n\nBefore.\n\n" +
      "![a red rectangle](/help/test-fixtures/red-rect.png)\n\nAfter.\n";
    const buffer = await packToBuffer(md);

    const { value: html } = await mammoth.convertToHtml({ buffer });
    // mammoth embeds images it can read as base64 data URIs — this only
    // succeeds if the .docx actually contains valid, readable image data.
    expect(html).toMatch(/<img alt="a red rectangle" src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  });

  it("does not leak the raw markdown image syntax as text, and keeps surrounding prose", async () => {
    const md =
      "Before.\n\n![a red rectangle](/help/test-fixtures/red-rect.png)\n\nAfter.\n";
    const buffer = await packToBuffer(md);

    const { value: text } = await mammoth.extractRawText({ buffer });
    expect(text).not.toContain("![a red rectangle]");
    expect(text).not.toContain("/help/test-fixtures/red-rect.png");
    expect(text).toContain("Before.");
    expect(text).toContain("After.");
  });

  it("skips a missing image without throwing, and doesn't print its raw syntax", async () => {
    const md = "![missing](/help/images/not-backfilled-yet.png)\nStill here.\n";
    const buffer = await packToBuffer(md);

    const { value: text } = await mammoth.extractRawText({ buffer });
    expect(text).not.toContain("![missing]");
    expect(text).not.toContain("/help/images/not-backfilled-yet.png");
    expect(text).toContain("Still here.");
  });
});

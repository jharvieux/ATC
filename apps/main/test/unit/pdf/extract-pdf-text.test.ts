// #1353 — extractPdfText must extract a text-layer PDF using the serverless-safe
// unpdf path (no @napi-rs/canvas native dep). This is a REAL extraction against a
// committed fixture — it would fail if the swap regressed to a parser that needs
// canvas/worker assets the way pdf-parse did in prod.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { extractPdfText } from "@/lib/pdf/extract-pdf-text";

const FIXTURE = join(process.cwd(), "apps", "main", "test", "fixtures", "sample-text.pdf");

describe("extractPdfText (#1353)", () => {
  it("extracts the text layer from a real PDF", async () => {
    const bytes = readFileSync(FIXTURE);
    const text = await extractPdfText(new Uint8Array(bytes));
    expect(text).toContain("QKXJV5F");
    expect(text).toContain("Norwegian Bliss");
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", async () => {
    const buf = readFileSync(FIXTURE);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    expect(await extractPdfText(ab)).toContain("QKXJV5F");
  });

  it("throws on bytes that are not a PDF (callers catch → parse_failed)", async () => {
    await expect(extractPdfText(new TextEncoder().encode("not a pdf"))).rejects.toBeDefined();
  });
});

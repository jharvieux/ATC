// §22.3 — OCR provider-selection tests.
//
// We only test the deterministic-by-design path here: 'none' explicit
// disable. The two recognizer call paths (GCV REST, tesseract.js) are
// integration-level and require real fixtures + an API key. Running the
// actual tesseract worker on synthetic bytes spawns a worker thread whose
// uncaught error breaks Vitest's clean-exit accounting even when the
// test-level assertion passes.

import { describe, it, expect, afterEach } from "vitest";
import { ocrImage } from "@/lib/rag-ingest/ocr";

describe("ocrImage — §22.3 provider selection", () => {
  afterEach(() => {
    delete process.env.RAG_INGEST_OCR_PROVIDER;
    delete process.env.GCV_API_KEY;
  });

  it("returns 'unavailable' when RAG_INGEST_OCR_PROVIDER='none'", async () => {
    process.env.RAG_INGEST_OCR_PROVIDER = "none";
    const out = await ocrImage(new ArrayBuffer(8));
    expect(out.status).toBe("unavailable");
    expect(out.error).toMatch(/OCR explicitly disabled/);
  });
});

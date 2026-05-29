// §22.3 — OCR provider-selection tests.
//
// We only test the deterministic-by-design path here: 'none' explicit
// disable. The two recognizer call paths (GCV REST, tesseract.js) are
// integration-level and require real fixtures + an API key. Running the
// actual tesseract worker on synthetic bytes spawns a worker thread whose
// uncaught error breaks Vitest's clean-exit accounting even when the
// test-level assertion passes.

import { describe, it, expect, afterEach, vi } from "vitest";
import { ocrImage } from "@/lib/rag-ingest/ocr";

describe("ocrImage — §22.3 provider selection", () => {
  afterEach(() => {
    delete process.env.RAG_INGEST_OCR_PROVIDER;
    delete process.env.GCV_API_KEY;
    vi.unstubAllGlobals();
  });

  it("returns 'unavailable' when RAG_INGEST_OCR_PROVIDER='none'", async () => {
    process.env.RAG_INGEST_OCR_PROVIDER = "none";
    const out = await ocrImage(new ArrayBuffer(8));
    expect(out.status).toBe("unavailable");
    expect(out.error).toMatch(/OCR explicitly disabled/);
  });

  // #396 / D-091 — the GCV API key must travel in the X-goog-api-key header,
  // never the URL query string (URLs leak into proxy/CDN/APM logs). This test
  // fails if a refactor moves the key back to ?key= or drops the header. A
  // successful GCV response keeps the path off the tesseract fallback, so no
  // worker thread spawns.
  it("sends the GCV API key in the X-goog-api-key header, not the URL", async () => {
    process.env.RAG_INGEST_OCR_PROVIDER = "gcv";
    process.env.GCV_API_KEY = "secret-key-123";

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return {
        ok: true,
        json: async () => ({ responses: [{ fullTextAnnotation: { text: "hello" } }] }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await ocrImage(new ArrayBuffer(8));

    expect(out.status).toBe("extracted");
    expect(out.provider).toBe("gcv");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedHeaders["X-goog-api-key"]).toBe("secret-key-123");
    expect(capturedUrl).toBe("https://vision.googleapis.com/v1/images:annotate");
    expect(capturedUrl).not.toContain("key=");
    expect(capturedUrl).not.toContain("secret-key-123");
  });
});

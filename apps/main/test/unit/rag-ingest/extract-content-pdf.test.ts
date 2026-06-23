// #1353 — extractContent's PDF branch: text layer → extracted; empty text layer
// → OCR fallback; OCR also fails → failed; extractor throws → pdf_parse_throw.
// The extractor is now unpdf (mocked here at the @/lib/pdf/extract-pdf-text
// boundary so this test pins the BRANCHING, not unpdf itself — that's covered by
// extract-pdf-text.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pdfText: "" as string,
  pdfThrows: false,
  ocr: { status: "failed", error: "no_ocr" } as {
    status: string;
    text?: string;
    error?: string;
  },
}));

vi.mock("@/lib/pdf/extract-pdf-text", () => ({
  extractPdfText: vi.fn(async () => {
    if (h.pdfThrows) throw new Error("boom");
    return h.pdfText;
  }),
}));
vi.mock("@/lib/rag-ingest/ocr", () => ({
  ocrImage: vi.fn(async () => h.ocr),
}));

import { extractContent } from "@/lib/rag-ingest/extract-content";

function db() {
  return {
    storage: {
      from: () => ({
        download: async () => ({
          data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
          error: null,
        }),
      }),
    },
  } as unknown as Parameters<typeof extractContent>[0]["db"];
}

const opts = () => ({ db: db(), storage_path: "x.pdf", mime_type: "application/pdf" });

beforeEach(() => {
  vi.clearAllMocks();
  h.pdfText = "";
  h.pdfThrows = false;
  h.ocr = { status: "failed", error: "no_ocr" };
});

describe("extractContent PDF branch (#1353)", () => {
  it("text layer present → extracted, OCR never called", async () => {
    h.pdfText = "QKXJV5F Norwegian Bliss";
    const { ocrImage } = await import("@/lib/rag-ingest/ocr");
    const res = await extractContent(opts());
    expect(res).toEqual({ status: "extracted", content: "QKXJV5F Norwegian Bliss" });
    expect(ocrImage).not.toHaveBeenCalled();
  });

  it("empty text layer → OCR fallback succeeds → extracted", async () => {
    h.pdfText = "";
    h.ocr = { status: "extracted", text: "ocr text" };
    const res = await extractContent(opts());
    expect(res).toEqual({ status: "extracted", content: "ocr text" });
  });

  it("empty text layer + OCR fails → failed with descriptive error", async () => {
    h.pdfText = "";
    h.ocr = { status: "failed", error: "provider_down" };
    const res = await extractContent(opts());
    expect(res.status).toBe("failed");
    expect(res.error).toContain("pdf_no_text_layer_ocr_failed");
  });

  it("extractor throws → failed:pdf_parse_throw (no false success)", async () => {
    h.pdfThrows = true;
    const res = await extractContent(opts());
    expect(res.status).toBe("failed");
    expect(res.error).toContain("pdf_parse_throw");
  });
});

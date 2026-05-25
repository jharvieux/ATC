// BP34 Phase D — PDF text extraction error-path tests.
//
// Success path (a real PDF round-trips through pdf-parse) is intentionally
// not tested here — pdf-parse is the upstream and its own integration
// tests cover that. We test the wrapper's error handling.

import { describe, expect, it } from "vitest";
import { extractPdfText } from "@/lib/import/pdf-extract";

function makeFakeSvc(opts: {
  blob: Buffer | null;
  error?: { message: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  return {
    storage: {
      from: (_bucket: string) => ({
        download: async (_path: string) => ({
          data: opts.blob
            ? {
                arrayBuffer: async () =>
                  opts.blob!.buffer.slice(opts.blob!.byteOffset, opts.blob!.byteOffset + opts.blob!.byteLength),
              }
            : null,
          error: opts.error ?? null,
        }),
      }),
    },
  };
}

describe("extractPdfText error paths", () => {
  it("returns storage_download_failed when storage errors", async () => {
    const r = await extractPdfText({
      svc: makeFakeSvc({ blob: null, error: { message: "not found" } }),
      storage_path: "tenant/missing.pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("storage_download_failed");
  });

  it("returns pdf_parse_failed or pdf_no_text_extracted on garbage bytes", async () => {
    const garbage = Buffer.from("not a pdf");
    const r = await extractPdfText({ svc: makeFakeSvc({ blob: garbage }), storage_path: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pdf_parse_failed|pdf_no_text_extracted/);
  });
});

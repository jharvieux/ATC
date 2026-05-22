// §22.3 — File extraction dispatch tests.
// Verifies text-based formats extract directly and binary formats return
// 'unavailable' until parser libraries are installed (operator decision).

import { describe, it, expect, vi } from "vitest";
import { extractContent } from "@/lib/rag-ingest/extract-content";

function mockDb(text: string | null) {
  const blob = text == null ? null : new Blob([text], { type: "text/plain" });
  return {
    storage: {
      from: () => ({
        download: vi.fn().mockResolvedValue({
          data: blob,
          error: blob ? null : { message: "not_found" },
        }),
      }),
    },
  } as unknown as Parameters<typeof extractContent>[0]["db"];
}

describe("extractContent — §22.3", () => {
  it("extracts text/plain directly", async () => {
    const out = await extractContent({
      db: mockDb("Wonder of the Seas — 7-night Caribbean."),
      storage_path: "tenant_x/rag_submissions/1/file.txt",
      mime_type: "text/plain",
    });
    expect(out.status).toBe("extracted");
    expect(out.content).toMatch(/Wonder of the Seas/);
  });

  it("extracts text/markdown directly", async () => {
    const out = await extractContent({
      db: mockDb("# Heading\n\nText."),
      storage_path: "p",
      mime_type: "text/markdown",
    });
    expect(out.status).toBe("extracted");
    expect(out.content).toMatch(/# Heading/);
  });

  it("returns 'unavailable' for PDF (parser not installed)", async () => {
    const out = await extractContent({
      db: mockDb("ignored"),
      storage_path: "p",
      mime_type: "application/pdf",
    });
    expect(out.status).toBe("unavailable");
    expect(out.error).toMatch(/pdf-parse/);
  });

  it("returns 'unavailable' for DOCX (parser not installed)", async () => {
    const out = await extractContent({
      db: mockDb("ignored"),
      storage_path: "p",
      mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(out.status).toBe("unavailable");
    expect(out.error).toMatch(/mammoth/);
  });

  it("returns 'unavailable' for images (OCR not configured)", async () => {
    const out = await extractContent({
      db: mockDb("ignored"),
      storage_path: "p",
      mime_type: "image/jpeg",
    });
    expect(out.status).toBe("unavailable");
    expect(out.error).toMatch(/OCR/);
  });

  it("returns 'failed' for unsupported MIME", async () => {
    const out = await extractContent({
      db: mockDb("ignored"),
      storage_path: "p",
      mime_type: "application/x-novel-format",
    });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/unsupported_mime/);
  });

  it("returns 'failed' when storage download fails", async () => {
    const out = await extractContent({
      db: mockDb(null),
      storage_path: "p",
      mime_type: "text/plain",
    });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/storage_download_failed/);
  });
});

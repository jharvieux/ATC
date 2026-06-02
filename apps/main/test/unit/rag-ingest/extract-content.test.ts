// §22.3 — File extraction dispatch tests.
// Verifies text-based formats extract directly, HTML stripping behavior, and
// failure paths (storage download error, unsupported MIME, legacy .doc/.xls).
//
// Binary format tests (PDF, DOCX, XLSX, PPTX, OCR) are integration-only —
// they require either real binary fixtures or library mocks. The dispatch
// shape is the same; the parser branches are covered by their respective
// libraries' own test suites and exercised in staging on real uploads.

import { describe, it, expect, vi } from "vitest";
import { extractContent } from "@/lib/rag-ingest/extract-content";

function mockDb(payload: { text?: string; bytes?: ArrayBuffer } | null) {
  if (payload === null) {
    return {
      storage: {
        from: () => ({
          download: vi.fn().mockResolvedValue({ data: null, error: { message: "not_found" } }),
        }),
      },
    } as unknown as Parameters<typeof extractContent>[0]["db"];
  }
  const blob = payload.bytes
    ? new Blob([payload.bytes], { type: "application/octet-stream" })
    : new Blob([payload.text ?? ""], { type: "text/plain" });
  return {
    storage: {
      from: () => ({
        download: vi.fn().mockResolvedValue({ data: blob, error: null }),
      }),
    },
  } as unknown as Parameters<typeof extractContent>[0]["db"];
}

describe("extractContent — §22.3", () => {
  it("extracts text/plain directly", async () => {
    const out = await extractContent({
      db: mockDb({ text: "Wonder of the Seas — 7-night Caribbean." }),
      storage_path: "tenant_x/rag_submissions/1/file.txt",
      mime_type: "text/plain",
    });
    expect(out.status).toBe("extracted");
    expect(out.content).toMatch(/Wonder of the Seas/);
  });

  it("extracts text/markdown directly", async () => {
    const out = await extractContent({
      db: mockDb({ text: "# Heading\n\nText." }),
      storage_path: "p",
      mime_type: "text/markdown",
    });
    expect(out.status).toBe("extracted");
    expect(out.content).toMatch(/# Heading/);
  });

  it("strips nav/footer/script from HTML and returns body text", async () => {
    const html = `<html><body>
      <nav>Top nav</nav>
      <script>alert(1)</script>
      <main>Caribbean cruises depart Miami.</main>
      <footer>copyright stuff</footer>
    </body></html>`;
    const out = await extractContent({
      db: mockDb({ text: html }),
      storage_path: "p",
      mime_type: "text/html",
    });
    expect(out.status).toBe("extracted");
    expect(out.content).toMatch(/Caribbean cruises depart Miami/);
    expect(out.content).not.toMatch(/Top nav/);
    expect(out.content).not.toMatch(/alert/);
    expect(out.content).not.toMatch(/copyright/);
  });

  it("returns 'unavailable' for legacy .doc (libreoffice required)", async () => {
    const out = await extractContent({
      db: mockDb({ text: "ignored" }),
      storage_path: "p",
      mime_type: "application/msword",
    });
    expect(out.status).toBe("unavailable");
    expect(out.error).toMatch(/legacy_doc_format/);
  });

  it("returns 'unavailable' for legacy .xls (binary BIFF, no maintained reader)", async () => {
    const out = await extractContent({
      db: mockDb({ text: "ignored" }),
      storage_path: "p",
      mime_type: "application/vnd.ms-excel",
    });
    expect(out.status).toBe("unavailable");
    expect(out.error).toMatch(/legacy_xls_format/);
  });

  it("returns 'failed' for unsupported MIME", async () => {
    const out = await extractContent({
      db: mockDb({ text: "ignored" }),
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

  it("returns 'failed' on empty HTML body after strip", async () => {
    const html = `<html><body><nav>only nav</nav><script>x</script></body></html>`;
    const out = await extractContent({
      db: mockDb({ text: html }),
      storage_path: "p",
      mime_type: "text/html",
    });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/html_empty_after_strip/);
  });
});

// §22.3 — File content extraction dispatch.
//
// Routes by MIME type to a parser. All major formats are now implemented:
//   - text/plain, text/markdown: direct read.
//   - text/html: cheerio (strip nav/footer/scripts).
//   - application/pdf: unpdf (serverless-safe), falling back to OCR if the
//     PDF has no extractable text (image-only PDFs).
//   - DOCX: mammoth.
//   - DOC: NOT auto-converted (requires libreoffice binary on the function
//     host); returns 'unavailable' with a clear "convert to .docx" message.
//   - XLSX: exceljs, one logical block per sheet (CSV rows).
//   - XLS: NOT parsed (legacy binary format, no maintained JS reader); returns
//     'unavailable' with a "re-save as .xlsx" message.
//   - PPTX / PPT: officeparser (handles both).
//   - image/jpeg, image/png: OCR provider chain (GCV → tesseract fallback).
//
// All parser imports are dynamic — keeps cold-start light for handlers that
// don't extract files.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ocrImage } from "./ocr";

export type ExtractionStatus = "extracted" | "failed" | "unavailable";

export interface ExtractionResult {
  status: ExtractionStatus;
  content?: string;
  error?: string;
}

export async function extractContent(opts: {
  db: SupabaseClient;
  storage_path: string;
  mime_type: string;
}): Promise<ExtractionResult> {
  const { db, storage_path, mime_type } = opts;

  const { data: blob, error: dlErr } = await db.storage.from("rag-submissions").download(storage_path);
  if (dlErr || !blob) {
    return { status: "failed", error: `storage_download_failed: ${dlErr?.message ?? "unknown"}` };
  }

  switch (mime_type) {
    case "text/plain":
    case "text/markdown":
      return { status: "extracted", content: await blob.text() };

    case "text/html":
      return extractHtml(await blob.text());

    case "application/pdf":
      return extractPdf(await blob.arrayBuffer());

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocx(await blob.arrayBuffer());

    case "application/msword":
      return {
        status: "unavailable",
        error:
          "legacy_doc_format: .doc files require libreoffice on the function host. " +
          "Re-save as .docx and resubmit.",
      };

    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return extractXlsx(await blob.arrayBuffer());

    case "application/vnd.ms-excel":
      return {
        status: "unavailable",
        error:
          "legacy_xls_format: .xls (Excel 97–2003 binary) is no longer parsed. " +
          "Re-save as .xlsx and resubmit.",
      };

    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    case "application/vnd.ms-powerpoint":
      return extractPptx(await blob.arrayBuffer());

    case "image/jpeg":
    case "image/png": {
      const r = await ocrImage(await blob.arrayBuffer());
      if (r.status === "extracted") return { status: "extracted", content: r.text ?? "" };
      return { status: r.status, error: r.error ?? "ocr_failed" };
    }

    default:
      return { status: "failed", error: `unsupported_mime: ${mime_type}` };
  }
}

// ── HTML — cheerio strip nav/footer/scripts ─────────────────────────────────

async function extractHtml(html: string): Promise<ExtractionResult> {
  try {
    const { load } = await import("cheerio");
    const $ = load(html);
    $("script, style, nav, footer, noscript, iframe, header[role='banner']").remove();
    // Prefer the document's <main> or <article> if present; else fall back to body.
    const main = $("main, article").first();
    const node = main.length > 0 ? main : $("body");
    const text = node.text().replace(/\s+/g, " ").trim();
    if (text.length === 0) return { status: "failed", error: "html_empty_after_strip" };
    return { status: "extracted", content: text };
  } catch (err) {
    return { status: "failed", error: `html_parse_throw: ${String(err)}` };
  }
}

// ── PDF — unpdf (serverless-safe), OCR fallback on empty text ───────────────

async function extractPdf(bytes: ArrayBuffer): Promise<ExtractionResult> {
  try {
    const { extractPdfText } = await import("@/lib/pdf/extract-pdf-text");
    const text = await extractPdfText(bytes);

    if (text.length > 0) {
      return { status: "extracted", content: text };
    }

    // No text layer — try OCR.
    const ocr = await ocrImage(bytes);
    if (ocr.status === "extracted") {
      return { status: "extracted", content: ocr.text ?? "" };
    }
    return {
      status: ocr.status,
      error: `pdf_no_text_layer_ocr_${ocr.status}: ${ocr.error ?? "no_text_recovered"}`,
    };
  } catch (err) {
    return { status: "failed", error: `pdf_parse_throw: ${String(err)}` };
  }
}

// ── DOCX — mammoth (extract raw text, no styling) ───────────────────────────

async function extractDocx(bytes: ArrayBuffer): Promise<ExtractionResult> {
  try {
    const mammoth = await import("mammoth");
    const buf = Buffer.from(bytes);
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const text = (value ?? "").trim();
    if (text.length === 0) return { status: "failed", error: "docx_empty_after_extract" };
    return { status: "extracted", content: text };
  } catch (err) {
    return { status: "failed", error: `docx_parse_throw: ${String(err)}` };
  }
}

// ── XLSX — exceljs, one labeled block per sheet (CSV rows) ───────────────────

async function extractXlsx(bytes: ArrayBuffer): Promise<ExtractionResult> {
  try {
    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    // exceljs pins @types/node@14, whose Buffer brand differs from the workspace's
    // @types/node@25 — the runtime value is a valid Buffer, only the type tag clashes.
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const blocks: string[] = [];
    workbook.eachSheet((ws) => {
      const lines: string[] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = [];
        // CSV-escape: quote a field only if it holds the delimiter, a quote, or a
        // newline, doubling embedded quotes — matches SheetJS sheet_to_csv output.
        row.eachCell({ includeEmpty: true }, (cell) => {
          const v = cell.text;
          cells.push(/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        });
        lines.push(cells.join(","));
      });
      const csv = lines.join("\n").trim();
      if (csv.length === 0) return;
      blocks.push(`# Sheet: ${ws.name}\n${csv}`);
    });
    if (blocks.length === 0) return { status: "failed", error: "xlsx_no_sheets_with_data" };
    return { status: "extracted", content: blocks.join("\n\n") };
  } catch (err) {
    return { status: "failed", error: `xlsx_parse_throw: ${String(err)}` };
  }
}

// ── PPTX / PPT — officeparser ───────────────────────────────────────────────

async function extractPptx(bytes: ArrayBuffer): Promise<ExtractionResult> {
  try {
    const { convert } = await import("officeparser");
    const buf = Buffer.from(bytes);
    // OfficeConverter.convert returns { value: string } for destination 'text'.
    const result = await convert(buf, "text");
    const text = String(result?.value ?? "").trim();
    if (text.length === 0) return { status: "failed", error: "pptx_empty_after_extract" };
    return { status: "extracted", content: text };
  } catch (err) {
    return { status: "failed", error: `pptx_parse_throw: ${String(err)}` };
  }
}

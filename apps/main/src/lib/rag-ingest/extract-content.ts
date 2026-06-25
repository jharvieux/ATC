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
// ZIP-based formats (DOCX/XLSX/PPTX) are pre-screened for zip-bomb attack
// (#1387 / F-inp-02): the ZIP central directory is read from the buffer to sum
// uncompressed sizes BEFORE handing the buffer to the parser. A file whose
// entries expand beyond MAX_ZIP_UNCOMPRESSED_BYTES is rejected immediately so
// the OOXML parser never starts decompressing gigabytes into memory.
//
// All parser imports are dynamic — keeps cold-start light for handlers that
// don't extract files.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ocrImage } from "./ocr";

// ── ZIP bomb pre-check ───────────────────────────────────────────────────────
// Reads the ZIP End-of-Central-Directory record + per-entry uncompressed sizes
// from the central directory WITHOUT decompressing anything. Returns an error
// string if the archive would expand beyond the cap, or null if safe.
//
// OOXML files (DOCX/XLSX/PPTX) are ZIP archives. mammoth/exceljs/officeparser
// fully decompress before parsing — a ~50MB high-ratio DEFLATE bomb (~50:1 to
// 1000:1) OOMs the function before any output cap runs. This check runs first.

const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB

/** Exported for unit testing. Returns an error string if the buffer looks like a
 *  zip bomb, null if safe (or not a ZIP). */
export function checkZipBomb(bytes: ArrayBuffer): string | null {
  const buf = Buffer.from(bytes);
  const EOCD_SIG = 0x06054b50;
  const CD_SIG   = 0x02014b50;
  const MIN_EOCD  = 22;

  if (buf.length < MIN_EOCD) return null; // not a ZIP

  // Search backwards from the end for the EOCD signature.
  // ZIP allows up to 65535 bytes of comment after EOCD; clamp the search.
  const searchStart = Math.max(0, buf.length - 65535 - MIN_EOCD);
  let eocdOffset = -1;
  for (let i = buf.length - MIN_EOCD; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null; // not a recognized ZIP

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset     = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset >= buf.length) return "zip_eocd_cd_offset_overflow";

  let totalUncompressed = 0;
  let pos = cdOffset;
  for (let e = 0; e < totalEntries; e++) {
    if (pos + 46 > buf.length) break;
    if (buf.readUInt32LE(pos) !== CD_SIG) break;
    totalUncompressed += buf.readUInt32LE(pos + 24); // uncompressed size field
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      return `zip_bomb: total uncompressed size exceeds ${MAX_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024}MB`;
    }
    const fnLen      = buf.readUInt16LE(pos + 28);
    const extraLen   = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    pos += 46 + fnLen + extraLen + commentLen;
  }
  return null; // safe
}

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
  const bombErr = checkZipBomb(bytes);
  if (bombErr) return { status: "failed", error: `docx_zip_bomb: ${bombErr}` };
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
  const bombErr = checkZipBomb(bytes);
  if (bombErr) return { status: "failed", error: `xlsx_zip_bomb: ${bombErr}` };
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
  const bombErr = checkZipBomb(bytes);
  if (bombErr) return { status: "failed", error: `pptx_zip_bomb: ${bombErr}` };
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

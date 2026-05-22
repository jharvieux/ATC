// §22.3 — File content extraction dispatch.
//
// Routes by MIME type to a parser. Text-based formats (text/plain, text/markdown)
// extract directly with no library deps. Binary formats (PDF, DOCX, XLSX,
// PPTX, HTML, images) require library installs that are deferred — they
// return an ExtractionResult with status='unavailable' and a clear error
// message. Operator must install the libraries and remove the stub before
// these formats can be processed. Documented in MEMORY (D-054).
//
// The dispatcher is structured so that swapping a stub for a real parser is
// a one-line change in this file plus the actual import.

import type { SupabaseClient } from "@supabase/supabase-js";

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

  // Download file bytes from Supabase Storage.
  const { data: blob, error: dlErr } = await db.storage.from("rag-submissions").download(storage_path);
  if (dlErr || !blob) {
    return { status: "failed", error: `storage_download_failed: ${dlErr?.message ?? "unknown"}` };
  }

  switch (mime_type) {
    case "text/plain":
    case "text/markdown":
      return { status: "extracted", content: await blob.text() };

    case "text/html":
      // HTML extraction needs cheerio (operator install pending).
      return unavailable("text/html", "cheerio");

    case "application/pdf":
      return unavailable("application/pdf", "pdf-parse + OCR fallback");

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/msword":
      return unavailable(mime_type, "mammoth (DOCX) / libreoffice (DOC)");

    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.ms-excel":
      return unavailable(mime_type, "sheetjs (XLSX)");

    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    case "application/vnd.ms-powerpoint":
      return unavailable(mime_type, "pptxgenjs reader");

    case "image/jpeg":
    case "image/png":
      return unavailable(mime_type, `OCR (${process.env.RAG_INGEST_OCR_PROVIDER ?? "none"})`);

    default:
      return { status: "failed", error: `unsupported_mime: ${mime_type}` };
  }
}

function unavailable(mime: string, parser: string): ExtractionResult {
  return {
    status: "unavailable",
    error:
      `parser_not_installed: ${parser} required for ${mime}. ` +
      `Operator action: install the parser dependency and remove the stub from extract-content.ts.`,
  };
}

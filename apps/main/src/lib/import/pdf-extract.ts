// BP34 §34.3 Phase D — Text extraction from uploaded PDFs.
//
// Downloads the PDF from Supabase storage, runs pdf-parse, returns the
// extracted text. Truncates to a 64KB ceiling (the extractor's
// downstream prompt context is large but not unbounded). If extraction
// fails or returns empty text, returns null and the caller marks the
// queue row parse_failed.

import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_TEXT_BYTES = 64 * 1024;
const BUCKET = "imported-documents";

export async function extractPdfText(args: {
  svc: SupabaseClient;
  storage_path: string;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const { svc, storage_path } = args;

  const { data, error } = await svc.storage.from(BUCKET).download(storage_path);
  if (error || !data) {
    return { ok: false, reason: `storage_download_failed:${error?.message ?? "no_blob"}` };
  }

  let buf: Buffer;
  try {
    const ab = await data.arrayBuffer();
    buf = Buffer.from(ab);
  } catch (err) {
    return { ok: false, reason: `blob_read_failed:${err instanceof Error ? err.message : String(err)}` };
  }

  // pdf-parse is a CJS module; dynamic import keeps the bundler happy in
  // the Next.js App Router context and avoids loading it for code paths
  // that don't need it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfParse: any;
  try {
    const mod = await import("pdf-parse");
    pdfParse = (mod as { default?: unknown }).default ?? mod;
  } catch (err) {
    return { ok: false, reason: `pdf_parse_load_failed:${err instanceof Error ? err.message : String(err)}` };
  }

  let text: string;
  try {
    const parsed = (await pdfParse(buf)) as { text?: string };
    text = (parsed.text ?? "").trim();
  } catch (err) {
    return { ok: false, reason: `pdf_parse_failed:${err instanceof Error ? err.message : String(err)}` };
  }

  if (text.length === 0) {
    return { ok: false, reason: "pdf_no_text_extracted" };
  }

  // Cap to 64KB UTF-8 (the extractor's runner already truncates again
  // at its own limit but enforcing here keeps memory bounded).
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    text = text.slice(0, MAX_TEXT_BYTES);
  }

  return { ok: true, text };
}

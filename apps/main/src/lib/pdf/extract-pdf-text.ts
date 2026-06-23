// Serverless-safe PDF text extraction (#1353).
//
// We previously used pdf-parse (which wraps pdfjs-dist). On Vercel fluid
// compute pdfjs tried to load the native @napi-rs/canvas module, failed, and
// THREW — every uploaded-PDF import + RAG PDF ingest fell through to
// no_text_available / pdf_parse_throw in prod even for PDFs with a clean text
// layer. unpdf bundles a worker-free, canvas-free pdfjs build designed for
// serverless/edge, so getDocumentProxy + extractText run with no native deps.
//
// Returns the trimmed concatenated text. An empty string means the PDF has no
// extractable text layer (e.g. a scanned/image-only PDF) — callers decide
// whether to OCR or fail. Genuine parse errors throw; callers catch.

import { extractText } from "unpdf";

export async function extractPdfText(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { text } = await extractText(data, { mergePages: true });
  return (text ?? "").trim();
}

// §22.3 — OCR for images and OCR-only PDFs.
//
// Provider selection:
//   - RAG_INGEST_OCR_PROVIDER='gcv'       → Google Cloud Vision REST API
//                                            (uses GCV_API_KEY). On error,
//                                            falls back to tesseract.
//   - RAG_INGEST_OCR_PROVIDER='tesseract' → tesseract.js in-process.
//   - RAG_INGEST_OCR_PROVIDER='none'      → returns {status:'unavailable'}.
//   - default (no env or value missing)   → 'gcv' if GCV_API_KEY is present
//                                            and non-empty, otherwise 'tesseract'.
//
// Returns { status: 'extracted', text } or { status: 'unavailable'|'failed', error }.

export interface OcrResult {
  status: "extracted" | "failed" | "unavailable";
  text?: string;
  error?: string;
  provider?: "gcv" | "tesseract";
}

export async function ocrImage(bytes: ArrayBuffer): Promise<OcrResult> {
  const provider = pickProvider();

  if (provider === "none") {
    return {
      status: "unavailable",
      error: "RAG_INGEST_OCR_PROVIDER=none — OCR explicitly disabled",
    };
  }

  if (provider === "gcv") {
    const gcv = await ocrWithGcv(bytes);
    if (gcv.status === "extracted") return { ...gcv, provider: "gcv" };
    // GCV failure → fall through to tesseract.
    console.warn(`[ocr] GCV failed (${gcv.error}); falling back to tesseract`);
  }

  const tess = await ocrWithTesseract(bytes);
  return { ...tess, provider: "tesseract" };
}

function pickProvider(): "gcv" | "tesseract" | "none" {
  const explicit = (process.env.RAG_INGEST_OCR_PROVIDER ?? "").trim();
  if (explicit === "none") return "none";
  if (explicit === "gcv") return "gcv";
  if (explicit === "tesseract") return "tesseract";
  // Default: prefer GCV when an API key is present; otherwise tesseract.
  const key = (process.env.GCV_API_KEY ?? "").trim();
  return key ? "gcv" : "tesseract";
}

async function ocrWithGcv(bytes: ArrayBuffer): Promise<OcrResult> {
  const key = (process.env.GCV_API_KEY ?? "").trim();
  if (!key) return { status: "failed", error: "GCV_API_KEY_missing" };

  const base64 = Buffer.from(bytes).toString("base64");
  try {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      return { status: "failed", error: `gcv_http_${res.status}: ${t.slice(0, 200)}` };
    }
    const json = (await res.json()) as {
      responses?: Array<{
        fullTextAnnotation?: { text?: string };
        error?: { message?: string };
      }>;
    };
    const r = json.responses?.[0];
    if (r?.error?.message) return { status: "failed", error: `gcv_api_error: ${r.error.message}` };
    const text = r?.fullTextAnnotation?.text ?? "";
    return { status: "extracted", text };
  } catch (err) {
    return { status: "failed", error: `gcv_throw: ${String(err)}` };
  }
}

async function ocrWithTesseract(bytes: ArrayBuffer): Promise<OcrResult> {
  try {
    // Dynamic import — tesseract.js is large; only load when we actually OCR.
    const { recognize } = await import("tesseract.js");
    const buf = Buffer.from(bytes);
    const { data } = await recognize(buf, "eng");
    return { status: "extracted", text: data?.text ?? "" };
  } catch (err) {
    return { status: "failed", error: `tesseract_throw: ${String(err)}` };
  }
}

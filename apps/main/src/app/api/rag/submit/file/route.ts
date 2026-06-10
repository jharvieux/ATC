// §22.1 / §22.3 — File upload submission.
//
// Accepts multipart/form-data. Validates MIME against the supported set.
// The file is stored in Supabase Storage at:
//   tenant_{tenant_id}/rag_submissions/{submission_id}/{filename}
// and the submission row records the storage path. Stage 1 extraction
// (Inngest function rag-extract-content) reads the file and dispatches to
// the appropriate parser by MIME type.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createSubmission } from "@/lib/rag-ingest/create-submission";
import { respondToAuthError } from "@/lib/auth/respond";

// #750: cap the platform-layer body budget to the documented 50MB limit so
// oversized requests are rejected before the full body is buffered into heap.
export const maxRequestBodySize = "52mb";

const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/msword", // doc
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel", // xls
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.ms-powerpoint", // ppt
  "text/plain",
  "text/markdown",
  "text/html",
  "image/jpeg",
  "image/png",
]);

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "rag_submissions", action: "create" });
    const db = tenantClient(ctx);

    const maxBytes = Number(process.env.RAG_INGEST_MAX_FILE_SIZE_BYTES ?? 52_428_800);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "invalid_multipart" }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "file_required" }, { status: 400 });
    }
    if (file.size > maxBytes) {
      return Response.json(
        { error: "file_too_large", max_bytes: maxBytes, suggestion: "split_into_smaller_files" },
        { status: 413 },
      );
    }
    if (!SUPPORTED_MIMES.has(file.type)) {
      return Response.json(
        { error: "unsupported_mime", mime: file.type, supported: [...SUPPORTED_MIMES] },
        { status: 415 },
      );
    }

    // Upload to Supabase Storage. The bucket is created out-of-band by the
    // operator (one-time setup) — see docs/runbooks/rag-storage-bucket.md.
    const filename = sanitizeFilename(file.name);
    // We generate a submission ID up-front so the path is stable before the
    // row insert. UUID matches the DB default behavior.
    const submissionId = crypto.randomUUID();
    const storagePath = `tenant_${ctx.tenant_id}/rag_submissions/${submissionId}/${filename}`;

    const bytes = await file.arrayBuffer();

    // #720: reject files whose magic bytes don't match the declared MIME type.
    // file.type is attacker-controlled; magic bytes are not. Clamp to actual
    // file length so tiny files (< 8 bytes) don't throw RangeError.
    const magic = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
    if (!magicBytesMatch(file.type, magic)) {
      return Response.json({ error: "magic_bytes_mismatch", declared_mime: file.type }, { status: 415 });
    }

    const { error: uploadErr } = await db.storage
      .from("rag-submissions")
      .upload(storagePath, bytes, {
        contentType: file.type,
        upsert: false,
      });
    if (uploadErr) {
      return Response.json({ error: "storage_upload_failed", detail: uploadErr.message }, { status: 502 });
    }

    // Insert the submission row with the pre-generated ID.
    const { error: insertErr } = await db
      .from("rag_submissions")
      .insert({
        id: submissionId,
        tenant_id: ctx.tenant_id,
        submitted_by_user_id: user.id,
        submission_method: "file_upload",
        source_title: filename,
        original_file_path: storagePath,
        original_file_mime_type: file.type,
        extraction_status: "pending",
      });
    if (insertErr) {
      return Response.json({ error: "submission_insert_failed", detail: insertErr.message }, { status: 500 });
    }

    // Trigger the pipeline via the same helper — but the row already exists,
    // so just fire the Inngest event.
    const { inngest } = await import("@/inngest/client");
    await inngest.send({
      name: "rag.submission_needs_extraction",
      data: { submission_id: submissionId, tenant_id: ctx.tenant_id },
    });

    return Response.json({ submission_id: submissionId, status: "pending" });
  } catch (err) {
    return respondToAuthError(err);
  }
}

// #720: PDF = "%PDF-" (5 bytes), Office Open XML (docx/xlsx/pptx) = PK\x03\x04 (4 bytes ZIP),
// legacy Office (doc/xls/ppt) = OLE2 Compound Document D0 CF 11 E0 (4 bytes).
// TXT, MD, HTML have no reliable magic bytes — accepted as-is.
// Images: JPEG = FF D8 FF, PNG = 89 50 4E 47.
function magicBytesMatch(mime: string, magic: Uint8Array): boolean {
  if (mime === "application/pdf") {
    return magic[0] === 0x25 && magic[1] === 0x50 && magic[2] === 0x44 && magic[3] === 0x46 && magic[4] === 0x2d; // %PDF-
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04; // PK\x03\x04
  }
  if (
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.ms-powerpoint"
  ) {
    return magic[0] === 0xd0 && magic[1] === 0xcf && magic[2] === 0x11 && magic[3] === 0xe0; // OLE2
  }
  if (mime === "image/jpeg") {
    return magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff;
  }
  if (mime === "image/png") {
    return magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47;
  }
  // text/plain, text/markdown, text/html: no reliable magic bytes — accept as-is.
  return true;
}

function sanitizeFilename(name: string): string {
  // Allow alphanumerics, dots, hyphens, underscores; replace everything else.
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 200) || "upload";
}

// Suppress unused-import lint on createSubmission — kept for symmetry / future
// callers that pass extracted text alongside files.
void createSubmission;

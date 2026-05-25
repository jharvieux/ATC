// BP34 §34.3 / §34.9 — Document upload intake.
//
// Multipart upload of a single PDF file. Per user direction (2026-05-23)
// virus scanning is deferred for v1; we rely on a strict PDF-only MIME
// allowlist + size cap as the mitigation for the document path (the
// email path relies on Gmail's own scanning).
//
// Flow:
//   1. Tier-gate the request (§34.9: requires >= BYO Pro).
//   2. Validate file: PDF mime + 10MB cap.
//   3. Insert import_queue row at status='pending_classification'
//      (no virus_check state since we're skipping it).
//   4. Upload bytes to imported-documents bucket at
//      <tenant_id>/<import_queue_id>.pdf
//   5. Update the row's uploaded_file_path.
//   6. Emit import.queued — the orchestrator will pick text from the PDF
//      via Phase D's OCR step (for now, document path resolveText returns
//      null and the row goes to parse_failed, which is correct behavior
//      until OCR is wired).

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertIntakePathPermitted } from "@/lib/import/tier-gate";
import { inngest } from "@/inngest/client";

const MAX_BYTES = 10 * 1024 * 1024;
const BUCKET = "imported-documents";

export async function POST(req: Request): Promise<Response> {
  const { ctx, user } = await assertPermission(req, {
    resource: "imports.upload",
    action: "create",
  });

  const svc = createServiceRoleClient();
  const gate = await assertIntakePathPermitted(ctx.tenant_id, "document", svc);
  if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "invalid_multipart" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "file field required" }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return Response.json({ error: `mime_not_allowed:${file.type}`, allowed: ["application/pdf"] }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: `file_too_large`, max_bytes: MAX_BYTES }, { status: 413 });
  }

  // Insert queue row first to get the ID for the storage path.
  const { data: inserted, error: insErr } = await svc
    .from("import_queue")
    .insert({
      tenant_id: ctx.tenant_id,
      import_path: "document",
      source_ref: file.name,
      submitted_by_user_id: user.id,
      status: "pending_classification",
      uploaded_file_mime_type: file.type,
      uploaded_file_size_bytes: file.size,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return Response.json({ error: `queue_insert_failed: ${insErr?.message ?? "unknown"}` }, { status: 500 });
  }

  const queueRowId = (inserted as { id: string }).id;
  const objectPath = `${ctx.tenant_id}/${queueRowId}.pdf`;

  const arrayBuffer = await file.arrayBuffer();
  const { error: upErr } = await svc.storage.from(BUCKET).upload(objectPath, new Uint8Array(arrayBuffer), {
    contentType: file.type,
    upsert: false,
  });
  if (upErr) {
    // Roll back the queue row so we don't leave an orphan.
    await svc.from("import_queue").delete().eq("id", queueRowId);
    return Response.json({ error: `upload_failed: ${upErr.message}` }, { status: 500 });
  }

  await svc.from("import_queue").update({ uploaded_file_path: objectPath }).eq("id", queueRowId);
  await inngest.send({
    name: "import.queued",
    data: { tenant_id: ctx.tenant_id, import_queue_id: queueRowId },
  });

  return Response.json(
    { import_queue_id: queueRowId, status: "queued", uploaded_file_path: objectPath },
    { status: 202 },
  );
}

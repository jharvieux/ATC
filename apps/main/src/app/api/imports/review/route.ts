// BP34 §34.6 — Review queue: list pending items.
//
// Filters per §34.6.1: import_path, document_type, submitted_by.
// Pagination via limit/offset (default 50, max 200).

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const VALID_PATHS = new Set(["email", "document", "manual"]);
const VALID_TYPES = new Set([
  "lead_notification",
  "booking_confirmation",
  "commission_statement",
  "intake_form",
  "unknown",
]);

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "imports.review", action: "list" });
    const svc = createServiceRoleClient();
    const url = new URL(req.url);

    const importPath = url.searchParams.get("import_path");
    const documentType = url.searchParams.get("document_type");
    const submittedBy = url.searchParams.get("submitted_by_user_id");
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

    if (importPath && !VALID_PATHS.has(importPath)) {
      return Response.json({ error: `invalid import_path: ${importPath}` }, { status: 400 });
    }
    if (documentType && !VALID_TYPES.has(documentType)) {
      return Response.json({ error: `invalid document_type: ${documentType}` }, { status: 400 });
    }

    let query = svc
      .from("import_queue")
      .select(
        "id, import_path, source_ref, document_type, classification_confidence, extraction_overall_confidence, raw_extracted_fields, validation_flags, parse_failure_reason, submitted_by_user_id, uploaded_file_path, created_at",
        { count: "exact" },
      )
      .eq("tenant_id", ctx.tenant_id)
      .eq("status", "pending_review")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (importPath) query = query.eq("import_path", importPath);
    if (documentType) query = query.eq("document_type", documentType);
    if (submittedBy) query = query.eq("submitted_by_user_id", submittedBy);

    const { data, count, error } = await query;
    if (error) return dbErrorResponse(error);

    return Response.json({
      items: data ?? [],
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

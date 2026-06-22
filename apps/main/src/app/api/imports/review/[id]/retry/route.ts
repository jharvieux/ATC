// BP34 §34.3 / §34.6 — Retry a parse_failed import.
//
// Resets a parse_failed row back to pending_classification, clears the
// failure reason + purge timer, and re-emits import.queued so the pipeline
// reprocesses the already-uploaded source. Used to recover imports that
// failed for an environment reason (e.g. the pdf-parse bundling bug) once
// the underlying cause is fixed — the uploaded file is still in the bucket.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "@/inngest/client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwaitRowCount } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await props.params;
    const { ctx, user } = await assertPermission(_req, { resource: "imports.review", action: "retry" });
    const svc = createServiceRoleClient();
    const queueRowId = params.id;

    const { data: rowData, error: loadErr } = await svc
      .from("import_queue")
      .select("id, tenant_id, status, document_type")
      .eq("id", queueRowId)
      .maybeSingle();
    if (loadErr) return dbErrorResponse(loadErr);
    if (!rowData) return Response.json({ error: "not_found" }, { status: 404 });
    const row = rowData as { tenant_id: string; status: string; document_type: string | null };
    if (row.tenant_id !== ctx.tenant_id) return Response.json({ error: "forbidden" }, { status: 403 });
    if (row.status !== "parse_failed") {
      return Response.json({ error: `row_not_retryable:${row.status}` }, { status: 409 });
    }

    // CAS-guarded on status + tenant_id so a concurrent retry/accept can't
    // double-dispatch the pipeline. select('id') returns the matched rows;
    // exactly one must match or the guard tripped.
    try {
      await safeAwaitRowCount(
        svc
          .from("import_queue")
          .update({
            status: "pending_classification",
            parse_failure_reason: null,
            purgable_at: null,
          })
          .eq("id", queueRowId)
          .eq("tenant_id", ctx.tenant_id)
          .eq("status", "parse_failed")
          .select("id"),
        "import_queue.retry",
        1,
      );
    } catch {
      return Response.json({ error: "retry_conflict" }, { status: 409 });
    }

    await inngest.send({
      name: "import.queued",
      data: { tenant_id: ctx.tenant_id, import_queue_id: queueRowId },
    });

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: user.id,
      actor_type: "user",
      action: "import.retried",
      resource_type: "import_queue",
      resource_id: queueRowId,
      context: { document_type: row.document_type },
    });

    return Response.json({ retried: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}

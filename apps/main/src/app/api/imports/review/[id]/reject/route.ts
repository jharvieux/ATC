// BP34 §34.6 — Reject a review-queue item.
//
// Body: { reason: string, retain_for_followup?: boolean }
//
// retain_for_followup=true preserves the uploaded file (per §34.4
// "retained per §34.4 if the agent flags for follow-up"); otherwise the
// item enters the standard rejected-retention window (24h then purge).

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";

const REJECT_RETENTION_HOURS = 24;
const RETAIN_FOLLOWUP_HOURS = 7 * 24;

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const { ctx, user } = await assertPermission(req, { resource: "imports.review", action: "reject" });
  const svc = createServiceRoleClient();
  const queueRowId = params.id;

  const body = ((await req.json().catch(() => ({}))) ?? {}) as {
    reason?: unknown;
    retain_for_followup?: unknown;
  };
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return Response.json({ error: "reason required" }, { status: 400 });
  }
  const retainForFollowup = body.retain_for_followup === true;

  const { data: rowData, error: loadErr } = await svc
    .from("import_queue")
    .select("id, tenant_id, status, document_type")
    .eq("id", queueRowId)
    .maybeSingle();
  if (loadErr) return Response.json({ error: loadErr.message }, { status: 500 });
  if (!rowData) return Response.json({ error: "not_found" }, { status: 404 });
  const row = rowData as { tenant_id: string; status: string; document_type: string | null };
  if (row.tenant_id !== ctx.tenant_id) return Response.json({ error: "forbidden" }, { status: 403 });
  if (row.status !== "pending_review") {
    return Response.json({ error: `row_not_in_pending_review:${row.status}` }, { status: 409 });
  }

  const hours = retainForFollowup ? RETAIN_FOLLOWUP_HOURS : REJECT_RETENTION_HOURS;
  const purgable_at = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  await safeAwait(svc
    .from("import_queue")
    .update({
      status: "rejected",
      rejected_at: new Date().toISOString(),
      rejected_by_user_id: user.id,
      rejected_reason: body.reason,
      purgable_at,
    })
    .eq("id", queueRowId), "import_queue.update");

  await writeAuditLog({
    tenant_id: ctx.tenant_id,
    actor_user_id: user.id,
    actor_type: "user",
    action: "import.rejected",
    resource_type: "import_queue",
    resource_id: queueRowId,
    context: {
      document_type: row.document_type,
      reason: body.reason,
      retain_for_followup: retainForFollowup,
    },
  });

  return Response.json({ rejected: true });
}

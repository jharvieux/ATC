// BP31 §32.6.2 / §32.4.3 — Escalate a help-flow session to platform support.
//
// Sets help_sessions.escalated_to_human=TRUE + escalation_reason; fires an
// operator alert via the existing notification path (BP26
// sendOperatorAlert). No SLA — alert is informational; platform support
// follows up out-of-band.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { writeAuditLog } from "@/lib/audit/write";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "help_session", action: "update" });
    const body = (await req.json().catch(() => ({}))) as { escalation_reason?: string };
    const reason = body.escalation_reason?.trim().slice(0, 500) ?? "unspecified";

    const db = tenantClient(ctx);
    const { error } = await db
      .from("help_sessions")
      .update({ escalated_to_human: true, escalation_reason: reason })
      .eq("id", params.id);
    if (error) {
      return Response.json({ error: "db_error", message: error.message }, { status: 500 });
    }

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: user.id,
      actor_type: "user",
      action: "help.session_escalated",
      resource_type: "help_session",
      resource_id: params.id,
      changes: { escalation_reason: reason },
    });

    await sendOperatorAlert({
      severity: "low",
      signal: "help_session_escalated",
      detail: `Help session ${params.id} escalated to platform support.`,
      payload: { tenant_id: ctx.tenant_id, session_id: params.id, reason },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}

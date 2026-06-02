// BP31 §32.6.2 — Close a Help AI session.
//
// Body: { outcome: 'resolved'|'submitted'|'escalated'|'abandoned' }

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { writeAuditLog } from "@/lib/audit/write";
import { inngest } from "@/inngest/client";
import { respondToAuthError } from "@/lib/auth/respond";

const OUTCOMES = new Set(["resolved", "submitted", "escalated", "abandoned"]);

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "help_session", action: "update" });
    const body = (await req.json().catch(() => ({}))) as { outcome?: string };
    if (!body.outcome || !OUTCOMES.has(body.outcome)) {
      return Response.json({ error: "invalid_outcome" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const { error } = await db
      .from("help_sessions")
      .update({ ended_at: new Date().toISOString(), outcome: body.outcome })
      .eq("id", params.id);
    if (error) {
      return Response.json({ error: "db_error", message: error.message }, { status: 500 });
    }

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: user.id,
      actor_type: "user",
      action: "help.session_closed",
      resource_type: "help_session",
      resource_id: params.id,
      changes: { outcome: body.outcome },
    });

    await inngest.send({
      name: "help.session_closed",
      data: { tenant_id: ctx.tenant_id, session_id: params.id, outcome: body.outcome },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}

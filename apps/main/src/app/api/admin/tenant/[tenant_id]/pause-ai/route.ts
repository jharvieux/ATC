// §10.6 Per-tenant AI pause
//
// POST /api/admin/tenant/:tenant_id/pause-ai          { reason?, resume?: false }
// POST /api/admin/tenant/:tenant_id/pause-ai          { reason?, resume: true  }
//
// Flips tenants.ai_paused_by_platform. The customer chat route + help-AI
// route both check this column and return the §10.6 fallback when true,
// without ever calling Anthropic.
//
// Pre-fix this endpoint set tenants.status='suspended', which was the wrong
// lever — (a) the chat route doesn't check tenants.status, so the endpoint
// had no effect on the AI customer chat path; (b) tenants.status='suspended'
// is a tenant-lifecycle action per §3.2 (no new bookings, read-only), far
// broader than the AI-misbehavior scenario §10.6 describes. The dedicated
// column added by migration 20260627000005 is the correct fine-grained
// lever; suspension stays available for the broader compliance/billing case
// via /api/admin/tenants/[id]/terminate or direct admin action.
//
// Requires platform-admin. Wraps in withPlatformAdminAudit with reason
// "ai_kill_switch_tenant_pause" (or "ai_kill_switch_tenant_resume" on resume).

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

export async function POST(req: Request, props: { params: Promise<{ tenant_id: string }> }): Promise<Response> {
  const params = await props.params;
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "pause_ai")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const { tenant_id } = params;
  if (!tenant_id) {
    return Response.json({ error: "tenant_id required" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const reason = typeof bodyObj.reason === "string" ? bodyObj.reason : undefined;
  const resume = bodyObj.resume === true;
  const nextValue = !resume;

  try {
    await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: resume ? "ai_kill_switch_tenant_resume" : "ai_kill_switch_tenant_pause",
        operation: resume ? "tenant_ai_resume" : "tenant_ai_pause",
        reason_detail: reason ?? (resume ? "manual_tenant_resume" : "manual_tenant_pause"),
      },
      async (db) => {
        const { error } = await db
          .from("tenants")
          .update({ ai_paused_by_platform: nextValue })
          .eq("id", tenant_id);

        if (error) throw new Error(error.message);
      },
    );

    return Response.json({ ok: true, tenant_id, ai_paused_by_platform: nextValue });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal_error";
    return Response.json({ error: message }, { status: 500 });
  }
}

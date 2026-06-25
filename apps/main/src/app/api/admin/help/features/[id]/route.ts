// BP31 §32.6.5 — Platform admin decision on a feature request.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const DECISIONS = new Set(["accepted", "rejected", "deferred", "duplicate"]);

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "help")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as { decision?: string; decision_notes?: string };
  if (!body.decision || !DECISIONS.has(body.decision)) {
    return Response.json({ error: "invalid_decision" }, { status: 400 });
  }

  try {
    await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "help_feature_decision", operation: `feature_decision:${params.id}` },
      async (db, recordQuery) => {
        const { error } = await db
          .from("feature_requests")
          .update({
            decision: body.decision,
            decision_notes: body.decision_notes ?? null,
            decided_at: new Date().toISOString(),
          })
          .eq("id", params.id);
        if (error) throw new Error(error.message);
        recordQuery({ op: "update", table: "feature_requests", row_count: 1 });
      },
    );
    return Response.json({ ok: true });
  } catch (err) {
    return dbErrorResponse(err);
  }
}

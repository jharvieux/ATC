// BP31 §32.6.5 — Platform admin decision on a feature request.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

const DECISIONS = new Set(["accepted", "rejected", "deferred", "duplicate"]);

export async function PATCH(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const adminUserId = req.headers.get("x-admin-user-id");
  if (!adminUserId) return Response.json({ error: "unauthorized" }, { status: 401 });

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
    return Response.json({ error: err instanceof Error ? err.message : "internal_error" }, { status: 500 });
  }
}

// §27.11 — Deny (or read) a single override request.
//
// PATCH /api/admin/abuse/override-requests/[id]
//   Body: { action: "deny", deny_reason: string }
//   For "approve", admins POST /api/admin/abuse/overrides with
//   resulting_request_id=[this id], which atomically links the override
//   to the request and flips status to approved.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const adminUserId = req.headers.get("x-admin-user-id");
  if (!adminUserId) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.action !== "deny" || typeof b.deny_reason !== "string" || b.deny_reason.length < 5) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "abuse_override_request_review", operation: `abuse_override_request_deny:${id}` },
      async (db, recordQuery) => {
        const { error } = await db
          .from("tenant_override_requests")
          .update({
            status: "denied",
            reviewed_by_user_id: adminUserId,
            reviewed_at: new Date().toISOString(),
            deny_reason: b.deny_reason as string,
          })
          .eq("id", id)
          .eq("status", "pending");
        if (error) throw new Error(error.message);
        recordQuery({ op: "update", table: "tenant_override_requests", row_count: 1 });
      },
    );
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

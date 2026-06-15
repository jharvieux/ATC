// §27.11 — Admin queue of tenant-initiated override requests.
//
// GET    /api/admin/abuse/override-requests?status=pending|approved|denied
//   Default status=pending. Returns the queue with tenant_id, dimension,
//   requested_threshold_kind, current_state, requester user, and requested_at.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "abuse")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const status = new URL(req.url).searchParams.get("status") ?? "pending";
  if (!["pending", "approved", "denied"].includes(status)) {
    return Response.json({ error: "invalid_status" }, { status: 400 });
  }

  try {
    const items = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "abuse_override_request_review", operation: `abuse_override_request_list:${status}` },
      async (db, recordQuery) => {
        const { data } = await db
          .from("tenant_override_requests")
          .select("id, tenant_id, dimension, requested_threshold_kind, current_state, reason, requested_at, requested_by_user_id, status, reviewed_at, reviewed_by_user_id, resulting_override_id, deny_reason")
          .eq("status", status)
          .order("requested_at", { ascending: false })
          .limit(500);
        recordQuery({ op: "select", table: "tenant_override_requests", row_count: data?.length ?? 0 });
        return data ?? [];
      },
    );
    return Response.json({ ok: true, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

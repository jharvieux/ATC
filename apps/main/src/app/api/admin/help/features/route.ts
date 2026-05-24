// BP31 §32.6.5 — Cross-tenant admin view of feature requests.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

export async function GET(req: Request): Promise<Response> {
  const adminUserId = req.headers.get("x-admin-user-id");
  if (!adminUserId) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const items = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "help_admin_view", operation: "feature_requests_list" },
      async (db, recordQuery) => {
        const { data } = await db
          .from("feature_requests")
          .select("id, tenant_id, source_type, what, github_issue_number, github_issue_url, github_issue_state, decision, submitted_at, decided_at")
          .order("submitted_at", { ascending: false })
          .limit(200);
        recordQuery({ op: "select", table: "feature_requests", row_count: data?.length ?? 0 });
        return data ?? [];
      },
    );
    return Response.json({ items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "internal_error" }, { status: 500 });
  }
}

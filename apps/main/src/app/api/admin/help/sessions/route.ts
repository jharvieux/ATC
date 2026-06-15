// BP31 §32.6.5 — Cross-tenant admin view of help sessions.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "help")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const items = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "help_admin_view", operation: "help_sessions_list" },
      async (db, recordQuery) => {
        const { data } = await db
          .from("help_sessions")
          .select("id, tenant_id, user_id, session_type, source_surface, started_at, ended_at, outcome, escalated_to_human")
          .order("started_at", { ascending: false })
          .limit(200);
        recordQuery({ op: "select", table: "help_sessions", row_count: data?.length ?? 0 });
        return data ?? [];
      },
    );
    return Response.json({ items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "internal_error" }, { status: 500 });
  }
}

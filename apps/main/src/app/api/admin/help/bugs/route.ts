// BP31 §32.6.5 — Cross-tenant admin view of bug submissions.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const items = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "help_admin_view", operation: "bug_submissions_list" },
      async (db, recordQuery) => {
        const { data } = await db
          .from("bug_submissions")
          .select(
            "id, tenant_id, source_type, where_in_platform, confidence_score, github_issue_number, github_issue_url, github_issue_state, triage_state, submitted_at, closed_at",
          )
          .order("submitted_at", { ascending: false })
          .limit(200);
        recordQuery({ op: "select", table: "bug_submissions", row_count: data?.length ?? 0 });
        return data ?? [];
      },
    );
    return Response.json({ items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "internal_error" }, { status: 500 });
  }
}

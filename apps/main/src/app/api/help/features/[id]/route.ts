// BP31 §32.6.4 — Get a single feature request (tenant-scoped).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "feature_request", action: "read" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("feature_requests")
      .select(
        "id, source_type, submitter_user_id, what, why, current_workaround, expected_usage_frequency, github_issue_number, github_issue_url, github_issue_state, decision, decision_notes, submitted_at, decided_at",
      )
      .eq("id", params.id)
      .maybeSingle();
    if (error) return Response.json({ error: "db_error", message: error.message }, { status: 500 });
    if (!data) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}

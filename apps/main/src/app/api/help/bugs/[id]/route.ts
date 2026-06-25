// BP31 §32.6.3 — Get a single bug submission (tenant-scoped).
//
// Customer callers per §32.6.3 receive a redacted view: only a short
// reference ID + state. Tenant admins and platform staff see the full
// row including GitHub linkage. We distinguish via the auth context's
// role/source signals.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createHash } from "node:crypto";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

function shortReferenceId(bug_id: string): string {
  // BR-{first 8 chars of sha256(bug_id) in lowercase hex}.
  // Stable per submission; not a security boundary — purely a friendly
  // identifier the customer can quote without exposing the raw UUID.
  return "BR-" + createHash("sha256").update(bug_id).digest("hex").slice(0, 8).toUpperCase();
}

export async function GET(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "bug_submission", action: "read" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("bug_submissions")
      .select(
        "id, source_type, submitter_user_id, where_in_platform, actual_behavior, expected_behavior, steps_to_reproduce, frequency, browser_info, screenshots, confidence_score, confidence_factors, github_issue_number, github_issue_url, github_issue_state, triage_state, submitted_at, closed_at, resolution_summary",
      )
      .eq("id", params.id)
      .maybeSingle();
    if (error) return dbErrorResponse(error);
    if (!data) return Response.json({ error: "not_found" }, { status: 404 });

    const row = data as Record<string, unknown> & { submitter_user_id: string; id: string; github_issue_state: string };
    const isOwnSubmission = row.submitter_user_id === user.id;

    // §32.6.3 customer-redacted view: when the caller is the submitter AND
    // their source_type was 'customer', strip GitHub linkage + internal
    // triage state + help-session reference; return only the friendly id.
    if (isOwnSubmission && row.source_type === "customer") {
      return Response.json({
        reference_id: shortReferenceId(row.id),
        state: row.github_issue_state,
        submitted_at: row.submitted_at,
      });
    }

    return Response.json(row);
  } catch (err) {
    return respondToAuthError(err);
  }
}

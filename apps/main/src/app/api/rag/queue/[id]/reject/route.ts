// §22.5 — Reject a queued submission.
//
// Tenant admin rejects: rag_submissions.review_status → 'rejected', records
// the rejection reason, and emits 'tenant.rag_submission_rejected' for the
// BP27 abuse-signal subsystem (consumer is TODO until §27 ships).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { inngest } from "@/inngest/client";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "rag_submissions", action: "reject" });
    const db = tenantClient(ctx);
    const { id } = await params;

    let body: { reason?: string } = {};
    try {
      body = await req.json();
    } catch {
      // Empty body fine; reason becomes null.
    }

    const reason = body.reason?.trim() || null;

    const { data, error } = await db
      .from("rag_submissions")
      .update({
        review_status: "rejected",
        tenant_review_rejection_reason: reason,
        tenant_review_decision_by_user_id: user.id,
        tenant_review_decision_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("review_status", "ready_for_review")
      .select("id, tenant_id")
      .maybeSingle();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!data) return Response.json({ error: "not_found_or_not_pending" }, { status: 404 });

    await inngest.send({
      name: "tenant.rag_submission_rejected",
      data: {
        submission_id: id,
        tenant_id: (data as { tenant_id: string }).tenant_id,
        reason,
      },
    });

    return Response.json({ status: "rejected" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

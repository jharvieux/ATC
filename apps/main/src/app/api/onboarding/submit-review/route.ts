// §15.10 — Onboarding Stage 11: Submit for platform review.
// Sets review_decision = 'pending', emits tenant.submitted_for_review event.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
import { inngest } from "@/inngest/client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "review:submit" });

    const db = tenantClient(ctx);
    const { error } = await db
      .from("tenants")
      .update({ review_decision: "pending" })
      .eq("id", ctx.tenant_id);

    if (error) {
      return dbErrorResponse(error);
    }

    await progressTo(ctx.tenant_id, "review_submitted");

    await inngest.send({
      name: "tenant.submitted_for_review",
      data: { tenant_id: ctx.tenant_id },
    });

    return Response.json({ ok: true, stage: "review_submitted" });
  } catch (err) {
    return respondToAuthError(err);
  }
}

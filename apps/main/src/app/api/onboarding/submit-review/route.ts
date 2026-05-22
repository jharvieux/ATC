// §15.10 — Onboarding Stage 11: Submit for platform review.
// Sets review_decision = 'pending', emits tenant.submitted_for_review event.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
import { inngest } from "@/inngest/client";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "review:submit" });

    const db = tenantClient(ctx);
    const { error } = await db
      .from("tenants")
      .update({ review_decision: "pending" })
      .eq("id", ctx.tenant_id);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await progressTo(ctx.tenant_id, "review_submitted");

    await inngest.send({
      name: "tenant.submitted_for_review",
      data: { tenant_id: ctx.tenant_id },
    });

    return Response.json({ ok: true, stage: "review_submitted" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

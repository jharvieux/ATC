// §15.10 — Onboarding Stage 10: Skip branding step.
// Advances directly from connect_setup to review_submitted.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "branding:skip" });
    await progressTo(ctx.tenant_id, "review_submitted");
    return Response.json({ ok: true, next_stage: "review_submitted" });
  } catch (err) {
    return respondToAuthError(err);
  }
}

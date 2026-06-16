// §15.10 — Onboarding Stage 10: Skip branding step.
//
// BYO hosts (tenant_type="byo_host") are NOT subject to platform review — they
// bring their own host relationship, so completing onboarding activates them
// immediately (status="active", onboarding_stage="complete"). They never reach
// the "awaiting review" screen.
//
// Sub-hosts still advance to review_submitted to await platform-admin approval.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { safeAwaitRowCount } from "@/lib/db/safe-mutation";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "branding:skip" });

    const db = tenantClient(ctx);
    const { data: tenant, error } = await db
      .from("tenants")
      .select("tenant_type, onboarding_stage")
      .eq("id", ctx.tenant_id)
      .single();

    if (error) return dbErrorResponse(error);

    if (tenant?.tenant_type === "byo_host") {
      // Self-activation — no admin approval. CAS-guarded on the current stage
      // so a concurrent writer (or a double-click) can't flip an already-moved
      // tenant; row count must be exactly 1. The `tenants` table is passed
      // through by tenantClient (its PK *is* the tenant id), so the tenant
      // boundary is the explicit `.eq("id", ctx.tenant_id)` on this
      // service-role query — the DB-layer constraint D-091 accepts. The
      // `.eq("onboarding_stage", ...)` is the CAS guard, not isolation.
      await safeAwaitRowCount(
        db
          .from("tenants")
          .update({
            status: "active",
            activated_at: new Date().toISOString(),
            onboarding_stage: "complete",
          })
          .eq("id", ctx.tenant_id)
          .eq("onboarding_stage", tenant.onboarding_stage)
          .select("id"),
        "tenants.update.byo_activate_on_branding_skip",
        1,
      );
      return Response.json({ ok: true, next_stage: "complete" });
    }

    await progressTo(ctx.tenant_id, "review_submitted");
    return Response.json({ ok: true, next_stage: "review_submitted" });
  } catch (err) {
    return respondToAuthError(err);
  }
}

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
      // Self-activation — no admin approval. `branding` is the ONLY legitimate
      // source stage: a BYO host reaches it via subscription→branding (§15.8
      // success_url) only AFTER Stripe checkout, so requiring it here is what
      // stops a direct POST from an earlier stage (signup/subscription/…) from
      // activating a tenant that never paid. The sub-host branch gets this
      // forward-transition guard for free from progressTo; the BYO branch must
      // enforce it explicitly (D-091: validate transitions at the boundary,
      // don't trust the caller's stage).
      if (tenant.onboarding_stage === "complete") {
        // Already activated (post-success double-click): idempotent no-op —
        // don't re-stamp activated_at or 500 a legitimate retry. Mirrors
        // progressTo's isAtOrPast short-circuit.
        return Response.json({ ok: true, next_stage: "complete" });
      }
      if (tenant.onboarding_stage !== "branding") {
        return Response.json({ error: "invalid_onboarding_stage" }, { status: 409 });
      }
      // CAS-guarded on `branding` so a concurrent writer / double-click that
      // already advanced the stage yields a zero-row mismatch (→ throw), not a
      // silent second activation. The tenant boundary is the explicit
      // `.eq("id", ctx.tenant_id)` — `tenants`' PK *is* the tenant id and
      // tenantClient passes it through, so this is the DB-layer constraint
      // D-091 requires; `.eq("onboarding_stage", "branding")` is the CAS guard.
      await safeAwaitRowCount(
        db
          .from("tenants")
          .update({
            status: "active",
            activated_at: new Date().toISOString(),
            onboarding_stage: "complete",
          })
          .eq("id", ctx.tenant_id)
          .eq("onboarding_stage", "branding")
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

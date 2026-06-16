// §3.1 / §15 — Advance a BYO tenant past inapplicable sub-host-only stages.
// Called by page guards on /onboarding/ica, /onboarding/tax-form, and
// /onboarding/connect when the tenant is tenant_type="byo_host". Returns
// the URL the client should redirect to.
// Returns 409 for non-BYO tenants (page renders normally for sub-hosts).

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo, type OnboardingStage } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const BYO_SKIP_MAP: Partial<Record<OnboardingStage, { target: OnboardingStage; redirectTo: string }>> = {
  ica:           { target: "state_of_operation", redirectTo: "/onboarding/state-of-operation" },
  tax_form:      { target: "state_of_operation", redirectTo: "/onboarding/state-of-operation" },
  connect_setup: { target: "branding",           redirectTo: "/onboarding/branding" },
};

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "byo:advance" });

    const db = tenantClient(ctx);
    const { data: tenant, error } = await db
      .from("tenants")
      .select("tenant_type, onboarding_stage")
      .eq("id", ctx.tenant_id)
      .single();

    if (error) return dbErrorResponse(error);

    if (tenant?.tenant_type !== "byo_host") {
      return Response.json({ error: "not_byo_host" }, { status: 409 });
    }

    const current = tenant.onboarding_stage as OnboardingStage;
    const skip = BYO_SKIP_MAP[current];

    if (!skip) {
      return Response.json({ error: "stage_not_skippable" }, { status: 409 });
    }

    await progressTo(ctx.tenant_id, skip.target);

    return Response.json({ redirect_to: skip.redirectTo });
  } catch (err) {
    return respondToAuthError(err);
  }
}

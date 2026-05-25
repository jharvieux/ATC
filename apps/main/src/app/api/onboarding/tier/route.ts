// §15.8 — Onboarding Stage 7: Tier selection with seat picker.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

interface TierSelectionBody {
  tier: "starter" | "pro" | "agency";
  billing_period: "monthly" | "annual";
  seat_count: number;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "tier:select" });

    let body: TierSelectionBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!["starter", "pro", "agency"].includes(body.tier)) {
      return Response.json({ error: "invalid_tier" }, { status: 422 });
    }

    if (!["monthly", "annual"].includes(body.billing_period)) {
      return Response.json({ error: "invalid_billing_period" }, { status: 422 });
    }

    const seatCount = body.tier === "agency" ? Math.max(1, body.seat_count ?? 1) : 1;

    // Resolve tier_id from tier_definitions table.
    const srDb = createServiceRoleClient();
    const { data: tierDef, error: tierErr } = await srDb
      .from("tier_definitions")
      .select("id")
      .eq("slug", body.tier)
      .maybeSingle();

    if (tierErr || !tierDef) {
      return Response.json({ error: "tier_not_found" }, { status: 422 });
    }

    const db = tenantClient(ctx);
    const { error } = await db
      .from("tenants")
      .update({
        tier_id: tierDef.id,
        seat_count: seatCount,
        billing_period: body.billing_period,
      })
      .eq("id", ctx.tenant_id);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await progressTo(ctx.tenant_id, "subscription");

    return Response.json({ ok: true, next_stage: "subscription" });
  } catch (err) {
    return respondToAuthError(err);
  }
}

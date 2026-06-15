// §15.8 — Onboarding Stage 7: Tier selection with seat picker.
// tier_definitions.code uses type-prefixed slugs (byo_agency, sub_starter, …).
// The UI sends bare tier names; we prefix from tenant_type here.

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

// Maps {tenant_type, tier} → tier_definitions.code per §3.3.
const TIER_CODE: Record<string, Record<string, string>> = {
  byo_host: { starter: "byo_research", pro: "byo_professional", agency: "byo_agency" },
  sub_host: { starter: "sub_starter",  pro: "sub_pro",          agency: "sub_agency"  },
};

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

    // Read tenant_type to resolve the correct prefixed tier code (§3.3).
    const readDb = tenantClient(ctx);
    const { data: tenantRow, error: tenantErr } = await readDb
      .from("tenants")
      .select("tenant_type")
      .eq("id", ctx.tenant_id)
      .single();
    if (tenantErr) return Response.json({ error: tenantErr.message }, { status: 500 });

    const tierCode = TIER_CODE[tenantRow?.tenant_type ?? ""]?.[body.tier];
    if (!tierCode) {
      return Response.json({ error: "invalid_tier_for_tenant_type" }, { status: 422 });
    }

    // Resolve tier_id from tier_definitions by code.
    const srDb = createServiceRoleClient();
    const { data: tierDef, error: tierErr } = await srDb
      .from("tier_definitions")
      .select("id")
      .eq("code", tierCode)
      .maybeSingle();

    if (tierErr || !tierDef) {
      return Response.json({ error: "tier_not_found" }, { status: 500 });
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

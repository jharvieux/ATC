// §15.3 — Onboarding Stage 2: Profile submission.
// Creates or updates the tenant row with profile data and advances stage.
// USPS address validation: TODO(usps-validator) — stubbed for Phase 1 launch.
// See MEMORY D-049 for validator deferral rationale.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

interface ProfileBody {
  legal_name: string;
  display_name: string;
  slug: string;
  mailing_address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  support_email: string;
  support_phone?: string;
  timezone: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "profile:submit" });

    let body: ProfileBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!body.legal_name || !body.display_name || !body.slug || !body.support_email || !body.timezone) {
      return Response.json({ error: "missing_required_fields" }, { status: 422 });
    }

    if (!/^[a-z0-9-]{3,63}$/.test(body.slug)) {
      return Response.json({ error: "invalid_slug_format" }, { status: 422 });
    }

    // TODO(usps-validator): add USPS address validation call here before Phase 2 launch.
    // For Phase 1: accept address as-is per §15.3 deferral.

    // Check slug uniqueness (service-role for cross-tenant query).
    const srDb = createServiceRoleClient();
    const { data: existing } = await srDb
      .from("tenants")
      .select("id")
      .eq("slug", body.slug)
      .neq("id", ctx.tenant_id)
      .maybeSingle();

    if (existing) {
      return Response.json({ error: "slug_taken" }, { status: 409 });
    }

    const db = tenantClient(ctx);
    const { error } = await db
      .from("tenants")
      .update({
        legal_name: body.legal_name,
        display_name: body.display_name,
        slug: body.slug,
        mailing_address: body.mailing_address,
        support_email: body.support_email,
        support_phone: body.support_phone ?? null,
        timezone: body.timezone,
      })
      .eq("id", ctx.tenant_id);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await progressTo(ctx.tenant_id, "legal");

    return Response.json({ ok: true, next_stage: "legal" });
  } catch (err) {
    return respondToAuthError(err);
  }
}

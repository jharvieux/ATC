// §15.3 — Onboarding profile endpoint.
// GET  — returns current tenant profile (used by the Edit Profile settings page).
// POST — updates profile fields; advances stage to "legal" if still at "profile"
//        (idempotent: progressTo no-ops when stage is already at or past "legal").
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

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "profile:read" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("tenants")
      .select("legal_name, display_name, slug, mailing_address, support_email, support_phone, timezone")
      .eq("id", ctx.tenant_id)
      .single();
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json(data);
  } catch (err) {
    return respondToAuthError(err);
  }
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
    const { data: existing, error: slugCheckErr } = await srDb
      .from("tenants")
      .select("id")
      .eq("slug", body.slug)
      .neq("id", ctx.tenant_id)
      .maybeSingle();

    if (slugCheckErr) return Response.json({ error: "internal_error" }, { status: 500 });
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
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }

    // Advance to "legal". If still at "signup", go through "profile" first —
    // direct signup→legal skips a stage and the state machine rejects it.
    try {
      await progressTo(ctx.tenant_id, "profile");
      await progressTo(ctx.tenant_id, "legal");
    } catch (err) {
      console.error("[onboarding/profile] stage advance failed after update committed; tenant_id:", ctx.tenant_id, err);
      return Response.json({ error: "stage_advance_failed" }, { status: 500 });
    }

    return Response.json({ ok: true, next_stage: "legal" });
  } catch (err) {
    return respondToAuthError(err);
  }
}

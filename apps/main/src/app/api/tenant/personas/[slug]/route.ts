// §9.5 — PATCH /api/tenant/personas/[slug]
// Accepts: display_name_override, system_prompt_addendum, is_disabled
// Tier-gates and Haiku-screens addendum changes.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { upsertPersonaOverride, type PersonaOverrideInput } from "@/lib/personas/upsert-persona-override";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const VALID_SLUGS = new Set([
  "marcus-cole",
  "marco-bellini",
  "priya-sharma",
  "captain-dave",
  "maya-patel",
  "jenny-hartwell",
]);

export async function PATCH(req: Request, props: { params: Promise<{ slug: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx } = await assertPermission(req, {
      resource: "tenant.personas",
      action: "tenant.config.update",
    });

    const { slug } = params;
    if (!VALID_SLUGS.has(slug)) {
      return Response.json({ error: `unknown persona slug: ${slug}` }, { status: 404 });
    }

    let body: {
      display_name_override?: string | null;
      system_prompt_addendum?: string | null;
      is_disabled?: boolean;
    };
    try {
      body = await req.json() as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    // tenants not in TENANT_SCOPED_TABLES — scope manually with .eq("id", ...)
    const db = tenantClient(ctx);
    const { data: tenant, error: tenantErr } = await db
      .from("tenants")
      .select("id, tier_id, background_ai_enabled")
      .eq("id", ctx.tenant_id)
      .single();

    if (tenantErr) return dbErrorResponse(tenantErr);
    if (!tenant) return Response.json({ error: "tenant_not_found" }, { status: 404 });

    // Resolve tier code: tier_definitions is PLATFORM_READABLE so tenantClient reads it.
    const { data: tierDef, error: tierErr } = await db
      .from("tier_definitions")
      .select("code")
      .eq("id", tenant.tier_id as string)
      .maybeSingle();

    if (tierErr) return dbErrorResponse(tierErr);
    if (!tierDef) return Response.json({ error: "tier_definition_missing" }, { status: 500 });

    const overrideInput: PersonaOverrideInput = {};
    if ("display_name_override" in body) overrideInput.display_name_override = body.display_name_override ?? null;
    if ("system_prompt_addendum" in body) overrideInput.system_prompt_addendum = body.system_prompt_addendum ?? null;
    if ("is_disabled" in body && body.is_disabled !== undefined) overrideInput.is_disabled = body.is_disabled;

    // Pass tenantClient so upsertPersonaOverride can write without its own DB client
    const result = await upsertPersonaOverride(
      {
        id: tenant.id as string,
        tier: tierDef.code as string,
        background_ai_enabled: (tenant.background_ai_enabled as boolean) ?? true,
      },
      slug,
      overrideInput,
      db,
    );

    if (!result.ok) {
      const detail = result as { ok: false; error: string; reasons?: string[] };
      return Response.json(
        { error: detail.error, reasons: detail.reasons },
        { status: 422 },
      );
    }

    return Response.json({ ok: true, id: result.id });
  } catch (err) {
    return respondToAuthError(err);
  }
}

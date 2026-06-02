// BP35 §35.7.1 — Tenant-configurable attribution category list.
//
// GET — list the tenant's active categories (in display_order).
// POST — add a new category (tier-gated: BYO Research cannot customise).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import type { TenantContext } from "@/lib/db/tenant-context";
import { respondToAuthError } from "@/lib/auth/respond";

const CUSTOMISATION_BLOCKED_TIERS: ReadonlySet<string> = new Set(["byo_research"]);

async function tenantTier(ctx: TenantContext): Promise<string | null> {
  const db = tenantClient(ctx);
  const { data } = await db
    .from("tenants")
    .select("tier_definitions!inner(code)")
    .eq("id", ctx.tenant_id)
    .maybeSingle();
  const t = (data as { tier_definitions?: { code?: string } | { code?: string }[] | null } | null)?.tier_definitions;
  return Array.isArray(t) ? t[0]?.code ?? null : t?.code ?? null;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "crm.attribution_categories", action: "list" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("tenant_attribution_categories")
      .select("id, category_label, display_order, is_active")
      .eq("is_active", true)
      .order("display_order", { ascending: true });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ categories: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "crm.attribution_categories", action: "create" });

    // §35.9 tier gate.
    const tier = await tenantTier(ctx);
    if (tier && CUSTOMISATION_BLOCKED_TIERS.has(tier)) {
      return Response.json({ error: `tier_does_not_permit_customisation:${tier}` }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as { category_label?: unknown; display_order?: unknown } | null;
    if (!body || typeof body.category_label !== "string" || body.category_label.trim().length === 0) {
      return Response.json({ error: "category_label required" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("tenant_attribution_categories")
      .insert({
        tenant_id: ctx.tenant_id,
        category_label: body.category_label.trim(),
        display_order: typeof body.display_order === "number" ? body.display_order : 100,
      })
      .select()
      .single();
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json(data, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

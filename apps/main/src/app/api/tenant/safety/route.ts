// §24.5 — Tenant supplemental hate-speech deny-list (Pro+ tier).
//
// Tenant-side ADDITIVE list — cannot remove from the platform list, only
// supplement. Stored on tenant_settings.supplemental_hate_speech_denylist.
//
// GET    /api/tenant/safety           → { terms: [...] }  (full strings; tenant owns these)
// POST   /api/tenant/safety           → { term, reason }
// DELETE /api/tenant/safety?term=...  → remove

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

const PRO_PLUS_TIERS = new Set(["sub_pro", "sub_agency", "byo_professional", "byo_agency"]);

async function loadTier(
  db: ReturnType<typeof tenantClient>,
  tenant_id: string,
): Promise<string> {
  const { data: t } = await db
    .from("tenants")
    .select("tier_id")
    .eq("id", tenant_id)
    .maybeSingle();
  const tierId = (t as { tier_id?: string } | null)?.tier_id ?? null;
  if (!tierId) return "byo_research";
  const { data: td } = await db
    .from("tier_definitions")
    .select("code")
    .eq("id", tierId)
    .maybeSingle();
  return (td as { code?: string } | null)?.code ?? "byo_research";
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Tenant safety settings",
      action: "get",
    });
    const db = tenantClient(ctx);
    const { data } = await db
      .from("tenant_settings")
      .select("supplemental_hate_speech_denylist")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    const terms = ((data as { supplemental_hate_speech_denylist?: unknown } | null)
      ?.supplemental_hate_speech_denylist ?? []) as string[];
    return Response.json({ terms });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Tenant safety add",
      action: "post",
    });
    const db = tenantClient(ctx);
    const tier = await loadTier(db, ctx.tenant_id);
    if (!PRO_PLUS_TIERS.has(tier)) {
      return Response.json(
        { error: "pro_plus_only", current_tier: tier },
        { status: 403 },
      );
    }

    const body = (await req.json()) as { term?: string };
    const term = String(body.term ?? "").trim();
    if (!term || term.length > 200) {
      return Response.json({ error: "invalid_term" }, { status: 422 });
    }

    const { data: existing } = await db
      .from("tenant_settings")
      .select("supplemental_hate_speech_denylist")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    const current = ((existing as { supplemental_hate_speech_denylist?: unknown } | null)
      ?.supplemental_hate_speech_denylist ?? []) as string[];
    const lower = term.toLowerCase();
    if (current.some((t) => t.toLowerCase() === lower)) {
      return Response.json({ ok: true, added: false });
    }
    const updated = [...current, term];

    if (existing) {
      await db
        .from("tenant_settings")
        .update({ supplemental_hate_speech_denylist: updated, updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenant_id);
    } else {
      await db
        .from("tenant_settings")
        .insert({ tenant_id: ctx.tenant_id, supplemental_hate_speech_denylist: updated });
    }
    return Response.json({ ok: true, added: true, count: updated.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Tenant safety remove",
      action: "delete",
    });
    const db = tenantClient(ctx);
    const tier = await loadTier(db, ctx.tenant_id);
    if (!PRO_PLUS_TIERS.has(tier)) {
      return Response.json({ error: "pro_plus_only" }, { status: 403 });
    }

    const url = new URL(req.url);
    const term = url.searchParams.get("term");
    if (!term) return Response.json({ error: "missing_term" }, { status: 400 });
    const lower = term.toLowerCase();

    const { data: existing } = await db
      .from("tenant_settings")
      .select("supplemental_hate_speech_denylist")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    const current = ((existing as { supplemental_hate_speech_denylist?: unknown } | null)
      ?.supplemental_hate_speech_denylist ?? []) as string[];
    const updated = current.filter((t) => t.toLowerCase() !== lower);
    if (updated.length === current.length) {
      return Response.json({ ok: true, removed: false });
    }
    await db
      .from("tenant_settings")
      .update({ supplemental_hate_speech_denylist: updated, updated_at: new Date().toISOString() })
      .eq("tenant_id", ctx.tenant_id);
    return Response.json({ ok: true, removed: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

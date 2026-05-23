// §24.9 — Tenant overrides for customer chat 3-tier caps (Pro+ tier).
//
// GET    /api/tenant/chat-limits
// PUT    /api/tenant/chat-limits     body: { soft1_cap, soft2_cap, hard_cap, booking_bonus_percent }
//
// Constraints enforced at write per §24.9:
//   • hard_cap in [hard_floor, hard_ceiling] (from platform_settings)
//   • soft1 < soft2 < hard
//   • booking_bonus_percent in [0, 400]

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

const PRO_PLUS_TIERS = new Set(["sub_pro", "sub_agency", "byo_professional", "byo_agency"]);

async function loadTier(db: ReturnType<typeof tenantClient>, tenant_id: string): Promise<string> {
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

async function loadPlatformInt(
  db: ReturnType<typeof tenantClient>,
  key: string,
  fallback: number,
): Promise<number> {
  const { data } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const v = (data as { value?: unknown } | null)?.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Tenant chat limits",
      action: "get",
    });
    const db = tenantClient(ctx);
    const { data } = await db
      .from("customer_chat_tenant_overrides")
      .select("soft1_cap, soft2_cap, hard_cap, booking_bonus_percent, updated_at")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    const tier = await loadTier(db, ctx.tenant_id);
    const platformDefaults = {
      soft1_cap: await loadPlatformInt(db, "customer_chat_soft1_cap", 20),
      soft2_cap: await loadPlatformInt(db, "customer_chat_soft2_cap", 30),
      hard_cap:  await loadPlatformInt(db, "customer_chat_hard_cap", 40),
      booking_bonus_percent: await loadPlatformInt(db, "customer_chat_booking_bonus_percent", 100),
      hard_ceiling: await loadPlatformInt(db, "customer_chat_limit_hard_ceiling", 200),
      hard_floor:   await loadPlatformInt(db, "customer_chat_limit_hard_floor", 15),
    };
    return Response.json({
      tier,
      can_override: PRO_PLUS_TIERS.has(tier),
      override: data ?? null,
      defaults: platformDefaults,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Tenant chat limits update",
      action: "put",
    });
    const db = tenantClient(ctx);
    const tier = await loadTier(db, ctx.tenant_id);
    if (!PRO_PLUS_TIERS.has(tier)) {
      return Response.json({ error: "pro_plus_only", current_tier: tier }, { status: 403 });
    }

    const body = (await req.json()) as {
      soft1_cap?: number;
      soft2_cap?: number;
      hard_cap?: number;
      booking_bonus_percent?: number;
    };

    const ceiling = await loadPlatformInt(db, "customer_chat_limit_hard_ceiling", 200);
    const floor   = await loadPlatformInt(db, "customer_chat_limit_hard_floor", 15);

    const s1 = Number(body.soft1_cap);
    const s2 = Number(body.soft2_cap);
    const hd = Number(body.hard_cap);
    const bn = Number(body.booking_bonus_percent);

    if (!Number.isInteger(s1) || !Number.isInteger(s2) || !Number.isInteger(hd) || !Number.isInteger(bn)) {
      return Response.json({ error: "non_integer_value" }, { status: 422 });
    }
    if (hd < floor || hd > ceiling) {
      return Response.json({ error: "hard_cap_out_of_range", floor, ceiling }, { status: 422 });
    }
    if (!(s1 < s2 && s2 < hd)) {
      return Response.json({ error: "ordering_violation_soft1_soft2_hard" }, { status: 422 });
    }
    if (bn < 0 || bn > 400) {
      return Response.json({ error: "booking_bonus_out_of_range" }, { status: 422 });
    }

    const userId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    const { data: existing } = await db
      .from("customer_chat_tenant_overrides")
      .select("tenant_id")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (existing) {
      await db
        .from("customer_chat_tenant_overrides")
        .update({
          soft1_cap: s1,
          soft2_cap: s2,
          hard_cap: hd,
          booking_bonus_percent: bn,
          updated_at: new Date().toISOString(),
          updated_by_user_id: userId,
        })
        .eq("tenant_id", ctx.tenant_id);
    } else {
      await db.from("customer_chat_tenant_overrides").insert({
        tenant_id: ctx.tenant_id,
        soft1_cap: s1,
        soft2_cap: s2,
        hard_cap: hd,
        booking_bonus_percent: bn,
        updated_by_user_id: userId,
      });
    }

    // §24.9 audit (stub until §26 audit_log lands).
    console.warn(
      "[audit-log:STUB] " +
        JSON.stringify({
          action: "customer_chat.cap_override",
          tenant_id: ctx.tenant_id,
          user_id: userId,
          new_caps: { soft1_cap: s1, soft2_cap: s2, hard_cap: hd, booking_bonus_percent: bn },
          _stub: "audit_log table not yet created",
        }),
    );
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

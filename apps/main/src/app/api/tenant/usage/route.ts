// §27.11 — Tenant-facing usage summary.
//
// Returns current-period counters + caps + state + override hints for the
// caller's tenant. Used by /settings/usage to render gauges and the
// "request override" form. RLS-scoped read.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { resolveThresholds, type AbuseDimension } from "@/lib/abuse/thresholds";
import type { TenantRevenueSnapshot } from "@/lib/abuse/revenue";
import { respondToAuthError } from "@/lib/auth/respond";

function currentPeriodRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

const TIER_CODES = new Set([
  "byo_research", "byo_professional", "byo_agency",
  "sub_starter", "sub_pro", "sub_agency",
]);

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "TenantUsage", action: "read" });
    const db = tenantClient(ctx);

    const { data: tenantRow } = await db
      .from("tenants")
      .select("id, tier_id, seat_count, billing_period")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    const t = tenantRow as { id: string; tier_id?: string | null; seat_count?: number; billing_period?: "monthly" | "annual" } | null;
    if (!t) return Response.json({ error: "tenant_not_found" }, { status: 404 });

    let tier_code: TenantRevenueSnapshot["tier_code"] = "byo_research";
    if (t.tier_id) {
      const { data: td } = await db.from("tier_definitions").select("code").eq("id", t.tier_id).maybeSingle();
      const c = (td as { code?: string } | null)?.code;
      if (c && TIER_CODES.has(c)) tier_code = c as TenantRevenueSnapshot["tier_code"];
    }
    const snapshot: TenantRevenueSnapshot & { tenant_id: string } = {
      tenant_id: t.id,
      tier_code,
      seat_count: t.seat_count ?? 1,
      billing_period: t.billing_period ?? "monthly",
    };

    const { data: ragRow } = await db
      .from("tenant_rag_quotas")
      .select("base_cap, promoted_chunks_count, current_tenant_chunks_count, rag_state")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    const promoted = Number((ragRow as { promoted_chunks_count?: number } | null)?.promoted_chunks_count ?? 0);

    const thresholds = await resolveThresholds(db, snapshot, promoted);

    const { data: metricsRow } = await db
      .from("tenant_usage_metrics")
      .select("ai_cost_cents, chat_messages_count, email_sent_count, group_invitees_count, ai_cost_limit_state, chat_volume_limit_state, email_volume_limit_state, group_invite_limit_state")
      .eq("tenant_id", ctx.tenant_id)
      .eq("billing_period", currentPeriodRange())
      .maybeSingle();
    const m = metricsRow as {
      ai_cost_cents: string | number;
      chat_messages_count: number;
      email_sent_count: number;
      group_invitees_count: number;
      ai_cost_limit_state: string;
      chat_volume_limit_state: string;
      email_volume_limit_state: string;
      group_invite_limit_state: string;
    } | null;

    const dims: Array<{ dimension: AbuseDimension; current: string; state: string; thresholds: { soft1: string; soft2: string; hard: string } }> = [
      {
        dimension: "ai_cost",
        current: String(m?.ai_cost_cents ?? 0),
        state: m?.ai_cost_limit_state ?? "ok",
        thresholds: { soft1: thresholds.ai_cost_cents.soft1.toString(), soft2: thresholds.ai_cost_cents.soft2.toString(), hard: thresholds.ai_cost_cents.hard.toString() },
      },
      {
        dimension: "chat_volume",
        current: String(m?.chat_messages_count ?? 0),
        state: m?.chat_volume_limit_state ?? "ok",
        thresholds: { soft1: String(thresholds.chat_volume_messages_monthly.soft1), soft2: String(thresholds.chat_volume_messages_monthly.soft2), hard: String(thresholds.chat_volume_messages_monthly.hard) },
      },
      {
        dimension: "email_volume",
        current: String(m?.email_sent_count ?? 0),
        state: m?.email_volume_limit_state ?? "ok",
        thresholds: { soft1: String(thresholds.email_volume_daily.soft1), soft2: String(thresholds.email_volume_daily.soft2), hard: String(thresholds.email_volume_daily.hard) },
      },
      {
        dimension: "group_invite",
        current: String(m?.group_invitees_count ?? 0),
        state: m?.group_invite_limit_state ?? "ok",
        thresholds: { soft1: String(thresholds.group_invite_monthly.soft1), soft2: String(thresholds.group_invite_monthly.soft2), hard: String(thresholds.group_invite_monthly.hard) },
      },
    ];

    const rag = {
      state: (ragRow as { rag_state?: string } | null)?.rag_state ?? "ok",
      current_chunks: Number((ragRow as { current_tenant_chunks_count?: number } | null)?.current_tenant_chunks_count ?? 0),
      promoted_chunks: promoted,
      base_cap: Number((ragRow as { base_cap?: number } | null)?.base_cap ?? thresholds.rag_cap_total.effective),
      approaching: thresholds.rag_cap_total.approaching,
      effective_cap: thresholds.rag_cap_total.effective,
    };

    return Response.json({ ok: true, dims, rag, period: currentPeriodRange() });
  } catch (err) {
    return respondToAuthError(err);
  }
}

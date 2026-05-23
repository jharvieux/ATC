// §27.4 — Threshold resolution across all five dimensions.
//
// Single source of truth — every call site that needs a threshold reads
// from here. Override rows from tenant_usage_overrides take precedence
// over computed values (documented in MEMORY D-060).
//
// Dimensions:
//   • ai_cost           — soft1/soft2/hard cents/month (§27.4.1)
//   • chat_volume       — soft1/soft2/hard messages/month (§27.4.3)
//   • email_volume      — soft1/soft2/hard sends/day (§27.4.4)
//   • group_invite      — soft1/soft2/hard invitees/month + per_group_max (§27.4.5)
//   • rag_cap           — base, effective (with promotion bonus), approaching (§27.4.2)

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeEffectiveMonthlyRevenue,
  tierReferenceRevenueCents,
  type TenantRevenueSnapshot,
} from "./revenue";

export type AbuseDimension = "ai_cost" | "chat_volume" | "email_volume" | "group_invite" | "rag_cap";

export interface ResolvedThresholds {
  ai_cost_cents:               { soft1: bigint; soft2: bigint; hard: bigint };
  chat_volume_messages_monthly: { soft1: number; soft2: number; hard: number };
  email_volume_daily:          { soft1: number; soft2: number; hard: number };
  group_invite_monthly:        { soft1: number; soft2: number; hard: number; per_group_max: number };
  rag_cap_total:               { base: number; effective: number; approaching: number };
  effective_monthly_revenue_cents: bigint;
}

// §27.4.3 base monthly chat messages per tier (reference values).
// TODO(tier_definitions): move into tier_definitions table once it's
// extended with the abuse-knob columns. For now, hardcoded per spec.
const TIER_CHAT_BASE_MONTHLY: Record<TenantRevenueSnapshot["tier_code"], number> = {
  byo_research:     500,
  byo_professional: 2000,
  byo_agency:       5000,
  sub_starter:      1000,
  sub_pro:          5000,
  sub_agency:      15000,
};

// §27.4.4 base daily email sends per tier.
const TIER_EMAIL_BASE_DAILY: Record<TenantRevenueSnapshot["tier_code"], number> = {
  byo_research:      50,
  byo_professional: 150,
  byo_agency:       500,
  sub_starter:      100,
  sub_pro:          500,
  sub_agency:      1500,
};

// §27.4.5 base monthly group invitees per tier.
const TIER_GROUP_INVITE_BASE_MONTHLY: Record<TenantRevenueSnapshot["tier_code"], number> = {
  byo_research:      0,    // BYO Research doesn't run group bookings
  byo_professional:  500,
  byo_agency:       2000,
  sub_starter:       500,
  sub_pro:          1000,
  sub_agency:       2000,
};

// §27.4.2 base RAG chunks per tier.
const TIER_RAG_BASE_CHUNKS: Record<TenantRevenueSnapshot["tier_code"], number> = {
  byo_research:      50,
  byo_professional: 200,
  byo_agency:       500,
  sub_starter:      100,
  sub_pro:          500,
  sub_agency:      2000,
};

const PROMOTION_BONUS_PER_CHUNK = 25; // §27.4.2

const GROUP_INVITE_PER_GROUP_MAX = 100; // §27.4.5 — independent of monthly cap

type OverrideRow = {
  dimension: AbuseDimension;
  tier_override: string | null;
  threshold_value: number; // BIGINT — Postgres returns as number via JS for cents-level values
  effective_from: string;
  effective_to: string | null;
};

/**
 * Apply tenant_usage_overrides to the computed thresholds. Override
 * precedence: an override row with dimension+tier_override matching the
 * tier replaces that exact threshold.
 */
function applyOverrides(
  base: ResolvedThresholds,
  overrides: OverrideRow[],
): ResolvedThresholds {
  const now = new Date().toISOString().slice(0, 10);
  for (const row of overrides) {
    if (row.effective_from > now) continue;
    if (row.effective_to !== null && row.effective_to < now) continue;
    const v = BigInt(row.threshold_value);
    switch (row.dimension) {
      case "ai_cost":
        if (row.tier_override === "soft1") base.ai_cost_cents.soft1 = v;
        else if (row.tier_override === "soft2") base.ai_cost_cents.soft2 = v;
        else if (row.tier_override === "hard") base.ai_cost_cents.hard = v;
        break;
      case "chat_volume":
        if (row.tier_override === "soft1") base.chat_volume_messages_monthly.soft1 = Number(v);
        else if (row.tier_override === "soft2") base.chat_volume_messages_monthly.soft2 = Number(v);
        else if (row.tier_override === "hard") base.chat_volume_messages_monthly.hard = Number(v);
        break;
      case "email_volume":
        if (row.tier_override === "soft1") base.email_volume_daily.soft1 = Number(v);
        else if (row.tier_override === "soft2") base.email_volume_daily.soft2 = Number(v);
        else if (row.tier_override === "hard") base.email_volume_daily.hard = Number(v);
        break;
      case "group_invite":
        if (row.tier_override === "soft1") base.group_invite_monthly.soft1 = Number(v);
        else if (row.tier_override === "soft2") base.group_invite_monthly.soft2 = Number(v);
        else if (row.tier_override === "hard") base.group_invite_monthly.hard = Number(v);
        break;
      case "rag_cap":
        if (row.tier_override === "base_cap") {
          // Recompute effective + approaching from the override base.
          base.rag_cap_total.base = Number(v);
          base.rag_cap_total.effective = Number(v) + PROMOTION_BONUS_PER_CHUNK * 0; // promoted-bonus applies at the call site
          base.rag_cap_total.approaching = Math.floor(base.rag_cap_total.effective * 0.85);
        }
        break;
    }
  }
  return base;
}

export interface ResolveThresholdsInput {
  tenant: TenantRevenueSnapshot;
  promoted_chunks_count: number;
  // Caller supplies overrides — keeps this fn synchronous + testable.
  overrides?: OverrideRow[];
}

export function resolveThresholdsSync(input: ResolveThresholdsInput): ResolvedThresholds {
  const { tenant, promoted_chunks_count } = input;

  // 1. Effective monthly revenue (the multiplier base).
  const monthlyRevenueCents = computeEffectiveMonthlyRevenue(tenant);
  const referenceRevenueCents = tierReferenceRevenueCents(tenant.tier_code);

  // 2. AI cost: revenue × {30, 50, 70}%.
  const pctSoft1 = BigInt(Number(process.env.ABUSE_AI_COST_SOFT1_PERCENT ?? 30));
  const pctSoft2 = BigInt(Number(process.env.ABUSE_AI_COST_SOFT2_PERCENT ?? 50));
  const pctHard  = BigInt(Number(process.env.ABUSE_AI_COST_HARD_PERCENT ?? 70));
  const ai_cost_cents = {
    soft1: (monthlyRevenueCents * pctSoft1) / 100n,
    soft2: (monthlyRevenueCents * pctSoft2) / 100n,
    hard:  (monthlyRevenueCents * pctHard) / 100n,
  };

  // 3. Volume dimensions: multiplier = revenue / reference.
  //    Multiplier captured as a numerator/denominator so we keep integer math.
  function scale(baseCount: number): number {
    if (referenceRevenueCents === 0n) return baseCount;
    const scaled = (BigInt(baseCount) * monthlyRevenueCents) / referenceRevenueCents;
    return Number(scaled);
  }

  const chatBase = TIER_CHAT_BASE_MONTHLY[tenant.tier_code] ?? 0;
  const chat_volume_messages_monthly = {
    soft1: scale(chatBase),
    soft2: scale(Math.floor(chatBase * 1.5)),
    hard:  scale(chatBase * 2),
  };

  const emailBase = TIER_EMAIL_BASE_DAILY[tenant.tier_code] ?? 0;
  const email_volume_daily = {
    soft1: scale(emailBase),
    soft2: scale(Math.floor(emailBase * 1.5)),
    hard:  scale(emailBase * 2),
  };

  const inviteBase = TIER_GROUP_INVITE_BASE_MONTHLY[tenant.tier_code] ?? 0;
  const group_invite_monthly = {
    soft1: scale(inviteBase),
    soft2: scale(Math.floor(inviteBase * 1.5)),
    hard:  scale(inviteBase * 2),
    per_group_max: GROUP_INVITE_PER_GROUP_MAX,
  };

  // 4. RAG cap.
  const ragBase = scale(TIER_RAG_BASE_CHUNKS[tenant.tier_code] ?? 0);
  const ragEffective = ragBase + PROMOTION_BONUS_PER_CHUNK * Math.max(0, promoted_chunks_count);
  const approachingPct = Number(process.env.ABUSE_RAG_APPROACHING_PERCENT ?? 85) / 100;
  const rag_cap_total = {
    base: ragBase,
    effective: ragEffective,
    approaching: Math.floor(ragEffective * approachingPct),
  };

  const computed: ResolvedThresholds = {
    ai_cost_cents,
    chat_volume_messages_monthly,
    email_volume_daily,
    group_invite_monthly,
    rag_cap_total,
    effective_monthly_revenue_cents: monthlyRevenueCents,
  };

  return applyOverrides(computed, input.overrides ?? []);
}

/**
 * Async variant that loads overrides from the DB. Use this at runtime
 * call sites; tests use the sync version with explicit overrides.
 */
export async function resolveThresholds(
  db: SupabaseClient,
  tenant: TenantRevenueSnapshot & { tenant_id: string },
  promoted_chunks_count: number,
): Promise<ResolvedThresholds> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db
    .from("tenant_usage_overrides")
    .select("dimension, tier_override, threshold_value, effective_from, effective_to")
    .eq("tenant_id", tenant.tenant_id)
    .lte("effective_from", today);
  const overrides = ((data ?? []) as OverrideRow[]).filter(
    (r) => r.effective_to === null || r.effective_to >= today,
  );
  return resolveThresholdsSync({ tenant, promoted_chunks_count, overrides });
}

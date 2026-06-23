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
  type PricingTable,
} from "./revenue";
import { loadPricingTable } from "@/lib/pricing/pricing-table";

export type AbuseDimension = "ai_cost" | "chat_volume" | "email_volume" | "group_invite" | "rag_cap" | "help_submission_rate";

export interface ResolvedThresholds {
  ai_cost_cents:               { soft1: bigint; soft2: bigint; hard: bigint };
  chat_volume_messages_monthly: { soft1: number; soft2: number; hard: number };
  email_volume_daily:          { soft1: number; soft2: number; hard: number };
  group_invite_monthly:        { soft1: number; soft2: number; hard: number; per_group_max: number };
  rag_cap_total:               { base: number; effective: number; approaching: number };
  /**
   * BP32 §32.11.2 — help/bug/feature submissions per tenant per DAY.
   * Tier-independent flat values; overrides supported via the standard
   * tenant_usage_overrides mechanism (tier_override = soft1/soft2/hard).
   * **Per-day semantics** — unlike the other 5 dimensions which are
   * per-billing-period, help_submission_rate resets daily at 00:05 UTC
   * via the `help-submission-daily-reset` cron. MEMORY D-068.
   */
  help_submission_rate_daily:  { soft1: number; soft2: number; hard: number };
  effective_monthly_revenue_cents: bigint;
}

// BP32 §32.11.2 — initial flat values, tier-independent. Recalibrate
// after first 90 days of usage.
const HELP_SUBMISSION_DEFAULT = { soft1: 20, soft2: 50, hard: 100 } as const;

/**
 * §27.4 — Base counts per tier. Source of truth is `tier_definitions`
 * (columns added in migration 20260625000004). The TIER_BASE_FALLBACK
 * below is a defense-in-depth backup for the case where the DB hasn't
 * been seeded yet (fresh local env, integration test that bypassed the
 * full migration set). It mirrors the migration's seed values.
 */
export interface TierBaseCounts {
  chat_base_monthly: number;
  email_base_daily: number;
  group_invite_base_monthly: number;
  rag_base_chunks: number;
}

const TIER_BASE_FALLBACK: Record<TenantRevenueSnapshot["tier_code"], TierBaseCounts> = {
  byo_research:     { chat_base_monthly:   500, email_base_daily:   50, group_invite_base_monthly:    0, rag_base_chunks:   50 },
  byo_professional: { chat_base_monthly:  2000, email_base_daily:  150, group_invite_base_monthly:  500, rag_base_chunks:  200 },
  byo_agency:       { chat_base_monthly:  5000, email_base_daily:  500, group_invite_base_monthly: 2000, rag_base_chunks:  500 },
  sub_starter:      { chat_base_monthly:  1000, email_base_daily:  100, group_invite_base_monthly:  500, rag_base_chunks:  100 },
  sub_pro:          { chat_base_monthly:  5000, email_base_daily:  500, group_invite_base_monthly: 1000, rag_base_chunks:  500 },
  sub_agency:       { chat_base_monthly: 15000, email_base_daily: 1500, group_invite_base_monthly: 2000, rag_base_chunks: 2000 },
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
      case "help_submission_rate":
        if (row.tier_override === "soft1") base.help_submission_rate_daily.soft1 = Number(v);
        else if (row.tier_override === "soft2") base.help_submission_rate_daily.soft2 = Number(v);
        else if (row.tier_override === "hard") base.help_submission_rate_daily.hard = Number(v);
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
  // Tier base counts from tier_definitions. Defaults to TIER_BASE_FALLBACK
  // (the migration's seed values) when omitted, so tests that don't pass a
  // row still get sensible numbers.
  tier_bases?: TierBaseCounts;
  // Subscription pricing from the DB (tier_definitions price columns +
  // pricing_seat_ladder). Omitted → the compute fns use PRICING_FALLBACK.
  pricing?: PricingTable;
}

export function resolveThresholdsSync(input: ResolveThresholdsInput): ResolvedThresholds {
  const { tenant, promoted_chunks_count } = input;
  const bases = input.tier_bases ?? TIER_BASE_FALLBACK[tenant.tier_code] ?? {
    chat_base_monthly: 0,
    email_base_daily: 0,
    group_invite_base_monthly: 0,
    rag_base_chunks: 0,
  };

  // 1. Effective monthly revenue (the multiplier base).
  const monthlyRevenueCents = computeEffectiveMonthlyRevenue(tenant, input.pricing);
  const referenceRevenueCents = tierReferenceRevenueCents(tenant.tier_code, input.pricing);

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

  const chatBase = bases.chat_base_monthly;
  const chat_volume_messages_monthly = {
    soft1: scale(chatBase),
    soft2: scale(Math.floor(chatBase * 1.5)),
    hard:  scale(chatBase * 2),
  };

  const emailBase = bases.email_base_daily;
  const email_volume_daily = {
    soft1: scale(emailBase),
    soft2: scale(Math.floor(emailBase * 1.5)),
    hard:  scale(emailBase * 2),
  };

  const inviteBase = bases.group_invite_base_monthly;
  const group_invite_monthly = {
    soft1: scale(inviteBase),
    soft2: scale(Math.floor(inviteBase * 1.5)),
    hard:  scale(inviteBase * 2),
    per_group_max: GROUP_INVITE_PER_GROUP_MAX,
  };

  // 4. RAG cap.
  const ragBase = scale(bases.rag_base_chunks);
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
    // BP32 — help_submission_rate is tier-independent (flat values); overrides
    // still flow through applyOverrides if an admin set one.
    help_submission_rate_daily: { ...HELP_SUBMISSION_DEFAULT },
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
  const [overridesRes, tierRes, pricing] = await Promise.all([
    db
      .from("tenant_usage_overrides")
      .select("dimension, tier_override, threshold_value, effective_from, effective_to")
      .eq("tenant_id", tenant.tenant_id)
      .lte("effective_from", today),
    db
      .from("tier_definitions")
      .select("chat_base_monthly, email_base_daily, group_invite_base_monthly, rag_base_chunks")
      .eq("code", tenant.tier_code)
      .maybeSingle(),
    loadPricingTable(db),
  ]);
  const overrides = ((overridesRes.data ?? []) as OverrideRow[]).filter(
    (r) => r.effective_to === null || r.effective_to >= today,
  );
  const tier_bases = (tierRes.data ?? undefined) as TierBaseCounts | undefined;
  return resolveThresholdsSync({
    tenant,
    promoted_chunks_count,
    overrides,
    pricing,
    ...(tier_bases ? { tier_bases } : {}),
  });
}

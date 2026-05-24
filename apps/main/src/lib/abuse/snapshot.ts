// BP27 — shared tenant snapshot loader.
//
// Extracted from lib/ai/call-wrapper.ts so callers outside the AI path
// (email send, group invites, RAG approval) can pass the right shape
// to the §27 counter helpers (lib/abuse/counters.ts) without duplicating
// the tier-lookup + ai-cost-state query.
//
// 30-second in-process cache. Safe to call on every request; cache hits
// short-circuit the two DB roundtrips. Cache key is tenant_id only —
// invalidation comes from the TTL.
//
// PLATFORM_TENANT_ID short-circuits to a healthy stub — platform-wide
// calls (cross-tenant crons) have no row in `tenants` and shouldn't
// drive usage attribution.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantRevenueSnapshot } from "./revenue";

// All-zero UUID — must match lib/ai/call-wrapper.ts PLATFORM_TENANT_ID.
export const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000000";

export type AiCostState = "ok" | "soft1" | "soft2" | "hard";

export interface CachedTenantSnapshot {
  tenant: TenantRevenueSnapshot & { tenant_id: string };
  ai_cost_state: AiCostState;
  fetched_at: number;
}

const TTL_MS = 30_000;
const cache = new Map<string, CachedTenantSnapshot>();

const VALID_TIER_CODES = new Set<TenantRevenueSnapshot["tier_code"]>([
  "byo_research", "byo_professional", "byo_agency",
  "sub_starter", "sub_pro", "sub_agency",
]);

export async function loadTenantSnapshot(
  db: SupabaseClient,
  tenant_id: string,
): Promise<CachedTenantSnapshot> {
  const cached = cache.get(tenant_id);
  if (cached && Date.now() - cached.fetched_at < TTL_MS) return cached;

  if (tenant_id === PLATFORM_TENANT_ID) {
    const fresh: CachedTenantSnapshot = {
      tenant: { tenant_id, tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
      ai_cost_state: "ok",
      fetched_at: Date.now(),
    };
    cache.set(tenant_id, fresh);
    return fresh;
  }

  const { data: tenantRow } = await db
    .from("tenants")
    .select("id, tier_id, seat_count, billing_period")
    .eq("id", tenant_id)
    .maybeSingle();
  if (!tenantRow) {
    return {
      tenant: { tenant_id, tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
      ai_cost_state: "ok",
      fetched_at: Date.now(),
    };
  }
  const tr = tenantRow as { tier_id: string; seat_count: number; billing_period: "monthly" | "annual" };

  let tier_code: TenantRevenueSnapshot["tier_code"] = "byo_research";
  if (tr.tier_id) {
    const { data: tierRow } = await db
      .from("tier_definitions")
      .select("code")
      .eq("id", tr.tier_id)
      .maybeSingle();
    const code = (tierRow as { code?: string } | null)?.code;
    if (code && VALID_TIER_CODES.has(code as TenantRevenueSnapshot["tier_code"])) {
      tier_code = code as TenantRevenueSnapshot["tier_code"];
    }
  }

  const { data: metricsRow } = await db
    .from("tenant_usage_metrics")
    .select("ai_cost_limit_state")
    .eq("tenant_id", tenant_id)
    .order("billing_period", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ai_cost_state = ((metricsRow as { ai_cost_limit_state?: string } | null)?.ai_cost_limit_state ?? "ok") as AiCostState;

  const fresh: CachedTenantSnapshot = {
    tenant: { tenant_id, tier_code, seat_count: tr.seat_count ?? 1, billing_period: tr.billing_period ?? "monthly" },
    ai_cost_state,
    fetched_at: Date.now(),
  };
  cache.set(tenant_id, fresh);
  return fresh;
}

/** Test-only: clear the in-process cache between specs. */
export function _resetSnapshotCacheForTests(): void {
  cache.clear();
}

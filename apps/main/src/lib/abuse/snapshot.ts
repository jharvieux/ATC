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
import { safeAwait } from "@/lib/db/safe-mutation";
import { BoundedTtlCache } from "@/lib/cache/bounded-ttl-cache";

// All-zero UUID — must match lib/ai/call-wrapper.ts PLATFORM_TENANT_ID.
export const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000000";

export type AiCostState = "ok" | "soft1" | "soft2" | "hard";

export interface CachedTenantSnapshot {
  tenant: TenantRevenueSnapshot & { tenant_id: string };
  ai_cost_state: AiCostState;
  // #1586 — surfaced so the chat hot path derives is_test + the per-tenant AI
  // kill switch from this one (cached) tenants read instead of two extra reads.
  // Both default false for the stub / platform-tenant / not-found cases.
  is_sandbox: boolean;
  ai_paused_by_platform: boolean;
}

const TTL_MS = 30_000;
const cache = new BoundedTtlCache<string, CachedTenantSnapshot>({ defaultTtlMs: TTL_MS });

const VALID_TIER_CODES = new Set<TenantRevenueSnapshot["tier_code"]>([
  "byo_research", "byo_professional", "byo_agency",
  "sub_starter", "sub_pro", "sub_agency",
]);

export async function loadTenantSnapshot(
  db: SupabaseClient,
  tenant_id: string,
  // #1586 — fires once per COLD load (cache miss that hits the DB) so the chat
  // route can count real config round-trips for its perf log. No-op on a hit.
  onDbRead?: () => void,
): Promise<CachedTenantSnapshot> {
  const cached = cache.get(tenant_id);
  if (cached) return cached;

  if (tenant_id === PLATFORM_TENANT_ID) {
    const fresh: CachedTenantSnapshot = {
      tenant: { tenant_id, tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
      ai_cost_state: "ok",
      is_sandbox: false,
      ai_paused_by_platform: false,
    };
    cache.set(tenant_id, fresh);
    return fresh;
  }

  onDbRead?.();

  // safeAwait so a read FAILURE throws (fail-closed) rather than being swallowed
  // as `null` and conflated with "tenant not found" → which returns the healthy
  // stub below (tier byo_research, ai_cost_state "ok") and under-enforces the
  // §27 AI cost gates downstream on any transient DB error (D-091).
  const tenantRow = await safeAwait(
    db
      .from("tenants")
      .select("id, tier_id, seat_count, billing_period, is_platform_internal, is_sandbox, ai_paused_by_platform")
      .eq("id", tenant_id)
      .maybeSingle(),
    "tenants.load-snapshot",
  );
  if (!tenantRow) {
    return {
      tenant: { tenant_id, tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
      ai_cost_state: "ok",
      is_sandbox: false,
      ai_paused_by_platform: false,
    };
  }
  const tr = tenantRow as { tier_id: string; seat_count: number; billing_period: "monthly" | "annual"; is_platform_internal?: boolean; is_sandbox?: boolean; ai_paused_by_platform?: boolean };
  const is_sandbox = Boolean(tr.is_sandbox);
  const ai_paused_by_platform = Boolean(tr.ai_paused_by_platform);

  let tier_code: TenantRevenueSnapshot["tier_code"] = "byo_research";
  if (tr.tier_id) {
    const tierRow = await safeAwait(
      db.from("tier_definitions").select("code").eq("id", tr.tier_id).maybeSingle(),
      "tier_definitions.load-snapshot",
    );
    const code = (tierRow as { code?: string } | null)?.code;
    if (code && VALID_TIER_CODES.has(code as TenantRevenueSnapshot["tier_code"])) {
      tier_code = code as TenantRevenueSnapshot["tier_code"];
    }
  }

  // Platform-internal tenants (Booking, future ATC-owned lines) are exempt from
  // AI cost gates — they should never see "temporarily unavailable" due to spend limits.
  // Tier identity is still resolved above so model selection and caps use the real tier.
  if (tr.is_platform_internal) {
    const fresh: CachedTenantSnapshot = {
      tenant: { tenant_id, tier_code, seat_count: tr.seat_count ?? 1, billing_period: tr.billing_period ?? "monthly" },
      ai_cost_state: "ok",
      is_sandbox,
      ai_paused_by_platform,
    };
    cache.set(tenant_id, fresh);
    return fresh;
  }

  const metricsRow = await safeAwait(
    db
      .from("tenant_usage_metrics")
      .select("ai_cost_limit_state")
      .eq("tenant_id", tenant_id)
      .order("billing_period", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "tenant_usage_metrics.load-ai-cost-state",
  );
  const ai_cost_state = ((metricsRow as { ai_cost_limit_state?: string } | null)?.ai_cost_limit_state ?? "ok") as AiCostState;

  const fresh: CachedTenantSnapshot = {
    tenant: { tenant_id, tier_code, seat_count: tr.seat_count ?? 1, billing_period: tr.billing_period ?? "monthly" },
    ai_cost_state,
    is_sandbox,
    ai_paused_by_platform,
  };
  cache.set(tenant_id, fresh);
  return fresh;
}

/** Test-only: clear the in-process cache between specs. */
export function _resetSnapshotCacheForTests(): void {
  cache.clear();
}

/** Evict a single tenant's cached snapshot — call after a state transition so the
 *  next loadTenantSnapshot on this instance forces a fresh DB read. */
export function evictTenantSnapshot(tenant_id: string): void {
  cache.delete(tenant_id);
}

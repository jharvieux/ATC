// Issue #689 — Helpers for fetching embedding-cost rows from the rag DB.
//
// Extracted from the route handler so the fault-tolerance contract (rag
// unreachable → empty results, dashboard still renders) can be unit-tested
// without wiring the entire withPlatformAdminAudit chain.

import { getRagReadClient } from "@/lib/db/rag-read";
import { parseBigIntCol } from "./aggregations";

export interface RagEmbeddingRows {
  daily: Array<{ created_at: string; cost_estimate_cents: unknown }>;
  byModel: Array<{
    vendor: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_estimate_cents: unknown;
  }>;
  /** tenant_id → sum of cost_estimate_cents over the current billing period */
  tenantPeriod: Map<string, number>;
}

const EMPTY_RESULT: RagEmbeddingRows = { daily: [], byModel: [], tenantPeriod: new Map() };

export async function fetchRagEmbeddingRows(
  thirtyDaysAgo: string,
  periodStartIso: string,
): Promise<RagEmbeddingRows> {
  try {
    const rag = getRagReadClient();
    const [dailyRes, modelRes, tenantRes] = await Promise.all([
      rag
        .from("rag_ai_call_log")
        .select("created_at, cost_estimate_cents")
        .gte("created_at", thirtyDaysAgo),
      rag
        .from("rag_ai_call_log")
        .select("vendor, model, input_tokens, output_tokens, cost_estimate_cents")
        .gte("created_at", thirtyDaysAgo),
      rag
        .from("rag_ai_call_log")
        .select("tenant_id, cost_estimate_cents")
        .gte("created_at", periodStartIso)
        .not("tenant_id", "is", null),
    ]);
    if (dailyRes.error || modelRes.error || tenantRes.error) {
      console.warn(
        "[resource-utilization] rag query error:",
        dailyRes.error?.message ?? modelRes.error?.message ?? tenantRes.error?.message,
      );
      return EMPTY_RESULT;
    }
    const tenantPeriod = new Map<string, number>();
    for (const r of (tenantRes.data ?? []) as Array<{
      tenant_id: string;
      cost_estimate_cents: unknown;
    }>) {
      tenantPeriod.set(
        r.tenant_id,
        (tenantPeriod.get(r.tenant_id) ?? 0) + parseBigIntCol(r.cost_estimate_cents),
      );
    }
    return {
      daily: (dailyRes.data ?? []) as RagEmbeddingRows["daily"],
      byModel: (modelRes.data ?? []) as RagEmbeddingRows["byModel"],
      tenantPeriod,
    };
  } catch (err) {
    console.warn(
      "[resource-utilization] rag read client unavailable, dashboard will show main-side data only:",
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY_RESULT;
  }
}

export function periodStartIso(period: string): string {
  // period shape: "[YYYY-MM-DD,YYYY-MM-DD)" — pull the lower bound.
  const m = period.match(/^\[(\d{4}-\d{2}-\d{2}),/);
  return m
    ? `${m[1]}T00:00:00Z`
    : new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      ).toISOString();
}

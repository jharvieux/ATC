// §27.7 — Abuse state machine.
//
// Monthly-cycling dimensions (ai_cost / chat_volume / email_volume /
// group_invite) are MONOTONIC within a billing period: once a tenant
// crosses into soft1, dropping back below soft1 in the same month does
// NOT revert the state. Next billing period starts fresh at 'ok'.
//
// RAG cap is NON-MONOTONIC: deletions immediately drop the state back.
//
// Every upward transition writes a usage_limit_events row and emits an
// abuse.state_transition Inngest event so BP28's notification consumer
// can fan out.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { resolveThresholds, type AbuseDimension, type ResolvedThresholds } from "./thresholds";
import type { TenantRevenueSnapshot } from "./revenue";
import { safeAwait } from "@/lib/db/safe-mutation";

export type AbuseState = "ok" | "soft1" | "soft2" | "hard";
export type RagState = "ok" | "approaching" | "at_cap" | "over_cap";

const ABUSE_RANK: Record<AbuseState, number> = { ok: 0, soft1: 1, soft2: 2, hard: 3 };

// Map dimension → (state column name, threshold accessor).
type DimMeta = {
  state_col: string;
  state_changed_col: string;
  monotonic: boolean;
};

// BP32 — help_submission_rate has per-day semantics (NOT per-billing-period)
// and a dedicated state machine in lib/abuse/help-submission-rate.ts.
// Excluded from this table; checkStateTransitionIfNeeded throws if invoked
// with that dimension.
const MONTHLY_DIM_META: Record<Exclude<AbuseDimension, "rag_cap" | "help_submission_rate">, DimMeta> = {
  ai_cost:      { state_col: "ai_cost_limit_state",       state_changed_col: "ai_cost_state_changed_at",       monotonic: true },
  chat_volume:  { state_col: "chat_volume_limit_state",   state_changed_col: "chat_volume_state_changed_at",   monotonic: true },
  email_volume: { state_col: "email_volume_limit_state",  state_changed_col: "email_volume_state_changed_at",  monotonic: true },
  group_invite: { state_col: "group_invite_limit_state",  state_changed_col: "group_invite_state_changed_at",  monotonic: true },
};

function classifyAbuse(value: bigint, thresholds: { soft1: bigint; soft2: bigint; hard: bigint }): AbuseState {
  if (value >= thresholds.hard) return "hard";
  if (value >= thresholds.soft2) return "soft2";
  if (value >= thresholds.soft1) return "soft1";
  return "ok";
}

function classifyRag(count: number, t: ResolvedThresholds["rag_cap_total"]): RagState {
  if (count >= t.effective) return count > t.effective ? "over_cap" : "at_cap";
  if (count >= t.approaching) return "approaching";
  return "ok";
}

export interface CheckTransitionInput {
  db: SupabaseClient;
  tenant: TenantRevenueSnapshot & { tenant_id: string };
  dimension: AbuseDimension;
  /** Current metric value. BigInt for ai_cost, number for the count dimensions. */
  metric_value: bigint | number;
  /** Required for the rag_cap dimension. */
  promoted_chunks_count?: number;
}

/**
 * Reads the row, classifies the new state, and only writes when the new
 * rank is HIGHER than the recorded rank (monotonic dimensions) or when
 * the new state differs (non-monotonic rag_cap).
 *
 * Safe to call after every increment — it's a no-op when no transition.
 */
export async function checkStateTransitionIfNeeded(input: CheckTransitionInput): Promise<void> {
  const { db, tenant, dimension, metric_value } = input;
  const thresholds = await resolveThresholds(db, tenant, input.promoted_chunks_count ?? 0);

  if (dimension === "rag_cap") {
    await transitionRag(db, tenant, Number(metric_value), thresholds);
    return;
  }
  if (dimension === "help_submission_rate") {
    // BP32 §32.11 — help_submission_rate has per-day semantics and its
    // own state machine in lib/abuse/help-submission-rate.ts. Routing
    // through this function is a programmer error.
    throw new Error(
      "checkStateTransitionIfNeeded: 'help_submission_rate' is handled by " +
        "lib/abuse/help-submission-rate.ts (per-day semantics; not per-billing-period).",
    );
  }
  await transitionMonthly(db, tenant, dimension, metric_value as bigint, thresholds);
}

async function transitionMonthly(
  db: SupabaseClient,
  tenant: TenantRevenueSnapshot & { tenant_id: string },
  dimension: Exclude<AbuseDimension, "rag_cap" | "help_submission_rate">,
  value: bigint,
  thresholds: ResolvedThresholds,
): Promise<void> {
  const meta = MONTHLY_DIM_META[dimension];
  const t = (() => {
    switch (dimension) {
      case "ai_cost":      return thresholds.ai_cost_cents;
      case "chat_volume":  return { soft1: BigInt(thresholds.chat_volume_messages_monthly.soft1), soft2: BigInt(thresholds.chat_volume_messages_monthly.soft2), hard: BigInt(thresholds.chat_volume_messages_monthly.hard) };
      case "email_volume": return { soft1: BigInt(thresholds.email_volume_daily.soft1), soft2: BigInt(thresholds.email_volume_daily.soft2), hard: BigInt(thresholds.email_volume_daily.hard) };
      case "group_invite": return { soft1: BigInt(thresholds.group_invite_monthly.soft1), soft2: BigInt(thresholds.group_invite_monthly.soft2), hard: BigInt(thresholds.group_invite_monthly.hard) };
    }
    // Unreachable — exhaustive switch above covers every value of the
    // narrowed dimension type.
    throw new Error(`unreachable: unknown monthly dimension ${dimension as string}`);
  })();

  const newState = classifyAbuse(value, t);

  const { data: rowAny } = await db
    .from("tenant_usage_metrics")
    .select("id, ai_cost_limit_state, chat_volume_limit_state, email_volume_limit_state, group_invite_limit_state")
    .eq("tenant_id", tenant.tenant_id)
    .order("billing_period", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = rowAny as unknown as Record<string, string> | null;
  if (!row) return; // No metrics row yet — the counter increment will create it.

  const currentState = row[meta.state_col] as AbuseState;
  if (ABUSE_RANK[newState] <= ABUSE_RANK[currentState]) return; // monotonic — no downgrade

  // Compute threshold_crossed for the audit row.
  const crossed =
    newState === "hard" ? t.hard :
    newState === "soft2" ? t.soft2 :
    newState === "soft1" ? t.soft1 : 0n;

  await safeAwait(db.from("usage_limit_events").insert({
    tenant_id: tenant.tenant_id,
    dimension,
    from_state: currentState,
    to_state: newState,
    metric_value: value.toString(),
    threshold_crossed: crossed.toString(),
  }), "usage_limit_events.insert");
  await safeAwait(db
    .from("tenant_usage_metrics")
    .update({
      [meta.state_col]: newState,
      [meta.state_changed_col]: new Date().toISOString(),
    })
    .eq("id", row.id as string)
    .eq("tenant_id", tenant.tenant_id), "tenant_usage_metrics.update");

  await inngest.send({
    name: "abuse.state_transition",
    data: {
      tenant_id: tenant.tenant_id,
      dimension,
      from_state: currentState,
      to_state: newState,
      metric_value: value.toString(),
      threshold_crossed: crossed.toString(),
    },
  });
}

async function transitionRag(
  db: SupabaseClient,
  tenant: TenantRevenueSnapshot & { tenant_id: string },
  count: number,
  thresholds: ResolvedThresholds,
): Promise<void> {
  const newState = classifyRag(count, thresholds.rag_cap_total);

  const { data: row } = await db
    .from("tenant_rag_quotas")
    .select("rag_state")
    .eq("tenant_id", tenant.tenant_id)
    .maybeSingle();

  if (!row) return; // Caller will UPSERT the quota row on first chunk write.

  const currentState = (row as { rag_state: RagState }).rag_state;
  if (currentState === newState) return;

  await safeAwait(db
    .from("tenant_rag_quotas")
    .update({ rag_state: newState, rag_state_changed_at: new Date().toISOString() })
    .eq("tenant_id", tenant.tenant_id), "tenant_rag_quotas.update");

  await safeAwait(db.from("tenant_rag_cap_events").insert({
    tenant_id: tenant.tenant_id,
    event_type: "state_transition",
    cap_before: thresholds.rag_cap_total.effective,
    cap_after: thresholds.rag_cap_total.effective,
    count_before: count,
    count_after: count,
    reason: `${currentState} → ${newState}`,
  }), "tenant_rag_cap_events.insert");

  await inngest.send({
    name: "abuse.state_transition",
    data: {
      tenant_id: tenant.tenant_id,
      dimension: "rag_cap",
      from_state: currentState,
      to_state: newState,
      metric_value: String(count),
      threshold_crossed: String(thresholds.rag_cap_total.effective),
    },
  });
}

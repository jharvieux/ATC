// §27.7 — Threshold recompute on subscription change.
//
// When a tenant's tier, seat count, or billing period changes, the
// resolved thresholds change too. We re-evaluate every dimension's state
// against current usage so the dashboard / state machine reflect the new
// tier's thresholds within seconds (not on next nightly recompute).
//
// Subscription changes are an exogenous event, so we ALLOW downgrades
// in state here (e.g., tier upgrade pushes "hard" back to "ok"). The
// monotonic rule only applies inside a stable threshold regime.

import { z } from "zod";
import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import type { AbuseDimension } from "@/lib/abuse/thresholds";
import type { TenantRevenueSnapshot } from "@/lib/abuse/revenue";
import { checkStateTransitionIfNeeded } from "@/lib/abuse/state-machine";

const SubscriptionChangedPayloadSchema = z.object({ tenant_id: z.string().optional() });

const TIER_CODES = new Set([
  "byo_research", "byo_professional", "byo_agency",
  "sub_starter", "sub_pro", "sub_agency",
]);

export function classifyAbuse(value: bigint, t: { soft1: bigint; soft2: bigint; hard: bigint }): "ok" | "soft1" | "soft2" | "hard" {
  if (value >= t.hard) return "hard";
  if (value >= t.soft2) return "soft2";
  if (value >= t.soft1) return "soft1";
  return "ok";
}

export function classifyRag(count: number, t: { approaching: number; effective: number }): "ok" | "approaching" | "at_cap" | "over_cap" {
  if (count > t.effective) return "over_cap";
  if (count === t.effective) return "at_cap";
  if (count >= t.approaching) return "approaching";
  return "ok";
}

export interface AbuseDimensionInput {
  dim: AbuseDimension;
  value: bigint;
  t: { soft1: bigint; soft2: bigint; hard: bigint };
  state_col: string;
  changed_col: string;
  currentState: string;
}

export interface AbuseTransition {
  dim: AbuseDimension;
  from: string;
  to: string;
  value: string;
  threshold: string;
}

// Recompute core: re-classify each dimension against current thresholds and
// emit a transition only when the state actually changes. Subscription change
// is exogenous, so downgrades (e.g. "hard" → "ok" after a tier upgrade) are
// emitted here too — the monotonic rule only applies inside a stable regime.
// `nowIso` is injected so the timestamp column is deterministic under test.
export function computeAbuseTransitions(
  dimensions: AbuseDimensionInput[],
  nowIso: string,
): { updates: Record<string, string>; transitions: AbuseTransition[] } {
  const updates: Record<string, string> = {};
  const transitions: AbuseTransition[] = [];
  for (const d of dimensions) {
    const newState = classifyAbuse(d.value, d.t);
    if (newState !== d.currentState) {
      updates[d.state_col] = newState;
      updates[d.changed_col] = nowIso;
      const crossed = newState === "hard" ? d.t.hard : newState === "soft2" ? d.t.soft2 : newState === "soft1" ? d.t.soft1 : 0n;
      transitions.push({
        dim: d.dim,
        from: d.currentState,
        to: newState,
        value: d.value.toString(),
        threshold: crossed.toString(),
      });
    }
  }
  return { updates, transitions };
}

export const thresholdRecomputeOnSubscriptionChange = inngest.createFunction(
  {
    id: "threshold-recompute-on-subscription-change",
    triggers: [{ event: "tenant.subscription_changed" }],
  },
  async ({ event }) => {
    const { tenant_id } = SubscriptionChangedPayloadSchema.parse(event.data);
    if (!tenant_id) return { skipped: "missing-tenant-id" };

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-inngest",
        reason: "cross_tenant_admin",
        operation: `threshold_recompute_on_subscription_change:${tenant_id}`,
      },
      async (db) => {
        // Fetch fresh tenant snapshot.
        const { data: tRow } = await db
          .from("tenants")
          .select("id, tier_id, seat_count, billing_period")
          .eq("id", tenant_id)
          .maybeSingle();
        const tenantRow = tRow as { id: string; tier_id?: string | null; seat_count?: number; billing_period?: "monthly" | "annual" } | null;
        if (!tenantRow) return { skipped: "tenant-not-found" };

        let tier_code: TenantRevenueSnapshot["tier_code"] = "byo_research";
        if (tenantRow.tier_id) {
          const { data: td } = await db.from("tier_definitions").select("code").eq("id", tenantRow.tier_id).maybeSingle();
          const c = (td as { code?: string } | null)?.code;
          if (c && TIER_CODES.has(c)) tier_code = c as TenantRevenueSnapshot["tier_code"];
        }
        const snapshot: TenantRevenueSnapshot & { tenant_id: string } = {
          tenant_id: tenantRow.id,
          tier_code,
          seat_count: tenantRow.seat_count ?? 1,
          billing_period: tenantRow.billing_period ?? "monthly",
        };

        // Promoted count needed for RAG cap.
        const { data: quotaRow } = await db
          .from("tenant_rag_quotas")
          .select("promoted_chunks_count, current_tenant_chunks_count, rag_state")
          .eq("tenant_id", tenant_id)
          .maybeSingle();
        const promoted = Number((quotaRow as { promoted_chunks_count?: number } | null)?.promoted_chunks_count ?? 0);
        const currentChunks = Number((quotaRow as { current_tenant_chunks_count?: number } | null)?.current_tenant_chunks_count ?? 0);

        // Each RPC locks the authoritative row, applies upgrade or downgrade,
        // and writes its outbox marker atomically. Concurrent counter calls can
        // no longer create duplicate transition audits from a stale snapshot.
        const changed = await Promise.all([
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "ai_cost", metric_value: 0n, allow_downgrade: true, reason: "subscription_change_recompute" }),
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "chat_volume", metric_value: 0n, allow_downgrade: true, reason: "subscription_change_recompute" }),
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "email_volume", metric_value: 0n, allow_downgrade: true, reason: "subscription_change_recompute" }),
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "group_invite", metric_value: 0n, allow_downgrade: true, reason: "subscription_change_recompute" }),
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "rag_cap", metric_value: currentChunks, promoted_chunks_count: promoted, reason: "subscription_change_recompute" }),
        ]);

        return { tenant_id, transitions: changed.filter(Boolean).length };
      },
    );
  },
);

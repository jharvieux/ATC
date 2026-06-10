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
import { resolveThresholds, type AbuseDimension } from "@/lib/abuse/thresholds";
import type { TenantRevenueSnapshot } from "@/lib/abuse/revenue";
import { safeAwait } from "@/lib/db/safe-mutation";

const SubscriptionChangedPayloadSchema = z.object({ tenant_id: z.string().optional() });

const TIER_CODES = new Set([
  "byo_research", "byo_professional", "byo_agency",
  "sub_starter", "sub_pro", "sub_agency",
]);

function currentBillingPeriodRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

function classifyAbuse(value: bigint, t: { soft1: bigint; soft2: bigint; hard: bigint }): "ok" | "soft1" | "soft2" | "hard" {
  if (value >= t.hard) return "hard";
  if (value >= t.soft2) return "soft2";
  if (value >= t.soft1) return "soft1";
  return "ok";
}

function classifyRag(count: number, t: { approaching: number; effective: number }): "ok" | "approaching" | "at_cap" | "over_cap" {
  if (count > t.effective) return "over_cap";
  if (count === t.effective) return "at_cap";
  if (count >= t.approaching) return "approaching";
  return "ok";
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

        const thresholds = await resolveThresholds(db, snapshot, promoted);

        // Read current metrics row for monthly dimensions.
        const period = currentBillingPeriodRange();
        const { data: metricsRow } = await db
          .from("tenant_usage_metrics")
          .select("id, ai_cost_cents, chat_messages_count, email_sent_count, group_invitees_count, ai_cost_limit_state, chat_volume_limit_state, email_volume_limit_state, group_invite_limit_state")
          .eq("tenant_id", tenant_id)
          .eq("billing_period", period)
          .maybeSingle();
        const rt = metricsRow as
          | {
              id: string;
              ai_cost_cents: string | number;
              chat_messages_count: number;
              email_sent_count: number;
              group_invitees_count: number;
              ai_cost_limit_state: string;
              chat_volume_limit_state: string;
              email_volume_limit_state: string;
              group_invite_limit_state: string;
            }
          | null;

        const updates: Record<string, string> = {};
        const transitions: Array<{ dim: AbuseDimension; from: string; to: string; value: string; threshold: string }> = [];

        if (rt) {
          const dimensions: Array<{
            dim: AbuseDimension;
            value: bigint;
            t: { soft1: bigint; soft2: bigint; hard: bigint };
            state_col: string;
            changed_col: string;
            currentState: string;
          }> = [
            {
              dim: "ai_cost", value: BigInt(rt.ai_cost_cents), t: thresholds.ai_cost_cents,
              state_col: "ai_cost_limit_state", changed_col: "ai_cost_state_changed_at",
              currentState: rt.ai_cost_limit_state,
            },
            {
              dim: "chat_volume", value: BigInt(rt.chat_messages_count),
              t: { soft1: BigInt(thresholds.chat_volume_messages_monthly.soft1), soft2: BigInt(thresholds.chat_volume_messages_monthly.soft2), hard: BigInt(thresholds.chat_volume_messages_monthly.hard) },
              state_col: "chat_volume_limit_state", changed_col: "chat_volume_state_changed_at",
              currentState: rt.chat_volume_limit_state,
            },
            {
              dim: "email_volume", value: BigInt(rt.email_sent_count),
              t: { soft1: BigInt(thresholds.email_volume_daily.soft1), soft2: BigInt(thresholds.email_volume_daily.soft2), hard: BigInt(thresholds.email_volume_daily.hard) },
              state_col: "email_volume_limit_state", changed_col: "email_volume_state_changed_at",
              currentState: rt.email_volume_limit_state,
            },
            {
              dim: "group_invite", value: BigInt(rt.group_invitees_count),
              t: { soft1: BigInt(thresholds.group_invite_monthly.soft1), soft2: BigInt(thresholds.group_invite_monthly.soft2), hard: BigInt(thresholds.group_invite_monthly.hard) },
              state_col: "group_invite_limit_state", changed_col: "group_invite_state_changed_at",
              currentState: rt.group_invite_limit_state,
            },
          ];

          for (const d of dimensions) {
            const newState = classifyAbuse(d.value, d.t);
            if (newState !== d.currentState) {
              updates[d.state_col] = newState;
              updates[d.changed_col] = new Date().toISOString();
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

          if (Object.keys(updates).length > 0) {
            await safeAwait(db.from("tenant_usage_metrics").update(updates).eq("id", rt.id), "tenant_usage_metrics.update");
          }
        }

        // RAG: count_against_cap = current_tenant_chunks_count (promoted are exempt).
        if (quotaRow) {
          const currentRagState = (quotaRow as { rag_state: string }).rag_state;
          const newRagState = classifyRag(currentChunks, thresholds.rag_cap_total);
          if (newRagState !== currentRagState) {
            await safeAwait(db
              .from("tenant_rag_quotas")
              .update({ rag_state: newRagState, rag_state_changed_at: new Date().toISOString() })
              .eq("tenant_id", tenant_id), "tenant_rag_quotas.update");
            transitions.push({
              dim: "rag_cap",
              from: currentRagState,
              to: newRagState,
              value: String(currentChunks),
              threshold: String(thresholds.rag_cap_total.effective),
            });
          }
        }

        // Audit + notify per transition.
        for (const t of transitions) {
          await safeAwait(db.from("usage_limit_events").insert({
            tenant_id,
            dimension: t.dim,
            from_state: t.from,
            to_state: t.to,
            metric_value: t.value,
            threshold_crossed: t.threshold,
            resolution_action: "subscription_change_recompute",
          }), "usage_limit_events.insert");
          await inngest.send({
            name: "abuse.state_transition",
            data: {
              tenant_id,
              dimension: t.dim,
              from_state: t.from,
              to_state: t.to,
              metric_value: t.value,
              threshold_crossed: t.threshold,
              reason: "subscription_change",
            },
          });
        }

        return { tenant_id, transitions: transitions.length };
      },
    );
  },
);

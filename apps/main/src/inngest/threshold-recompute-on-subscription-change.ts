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
import type { TenantRevenueSnapshot } from "@/lib/abuse/revenue";
import { checkStateTransitionIfNeeded } from "@/lib/abuse/state-machine";

const SubscriptionChangedPayloadSchema = z.object({ tenant_id: z.string().optional() });

const TIER_CODES = new Set([
  "byo_research", "byo_professional", "byo_agency",
  "sub_starter", "sub_pro", "sub_agency",
]);

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
          .select("promoted_chunks_count")
          .eq("tenant_id", tenant_id)
          .maybeSingle();
        const promoted = Number((quotaRow as { promoted_chunks_count?: number } | null)?.promoted_chunks_count ?? 0);

        // Each RPC locks the authoritative row, applies upgrade or downgrade,
        // and writes its outbox marker atomically. Concurrent counter calls can
        // no longer create duplicate transition audits from a stale snapshot.
        const changed = await Promise.all([
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "ai_cost", allow_downgrade: true, reason: "subscription_change_recompute" }),
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "chat_volume", allow_downgrade: true, reason: "subscription_change_recompute" }),
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "email_volume", allow_downgrade: true, reason: "subscription_change_recompute" }),
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "group_invite", allow_downgrade: true, reason: "subscription_change_recompute" }),
          checkStateTransitionIfNeeded({ db, tenant: snapshot, dimension: "rag_cap", promoted_chunks_count: promoted, reason: "subscription_change_recompute" }),
        ]);

        return { tenant_id, transitions: changed.filter(Boolean).length };
      },
    );
  },
);

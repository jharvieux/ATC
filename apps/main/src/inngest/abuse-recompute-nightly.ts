// §27.7 — Daily abuse-metrics recompute (safety net).
//
// Real-time UPSERTs can drift on rare conflict retries; this cron sweeps
// each active tenant and reconciles tenant_usage_metrics + tenant_rag_quotas
// against the ground-truth source tables. Any drift > 1 cent/row is
// corrected AND logged to abuse_recompute_drift_log for ongoing visibility.
//
// Wrapped in withPlatformAdminAudit. State machine re-evaluated after the
// reconcile so a tenant who silently crossed a threshold (real-time path
// missed it) advances state on this run.

import { inngest } from "./client";
import { withPlatformAdminAudit, platformAdminClient } from "@/lib/db/platform-admin-client";
import { checkStateTransitionIfNeeded } from "@/lib/abuse/state-machine";
import type { TenantRevenueSnapshot } from "@/lib/abuse/revenue";

const TIER_CODES = new Set([
  "byo_research", "byo_professional", "byo_agency",
  "sub_starter", "sub_pro", "sub_agency",
]);

function currentPeriodRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

interface DriftRecord {
  tenant_id: string;
  dimension: string;
  real_time_value: bigint;
  recomputed_value: bigint;
}

async function logDriftIfAny(records: DriftRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = platformAdminClient();
  const period = currentPeriodRange();
  await db.from("abuse_recompute_drift_log").insert(
    records.map((r) => ({
      tenant_id: r.tenant_id,
      dimension: r.dimension,
      real_time_value: r.real_time_value.toString(),
      recomputed_value: r.recomputed_value.toString(),
      drift_amount: (r.recomputed_value - r.real_time_value).toString(),
      billing_period: period,
    })),
  );
}

export const abuseRecomputeNightly = inngest.createFunction(
  {
    id: "abuse-recompute-nightly",
    triggers: [{ cron: "0 3 * * *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") {
      // Staging skips per §25.10 / BP26 pattern.
      return { skipped_for_staging: true };
    }
    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "cross_tenant_admin",
        operation: "abuse_recompute_nightly",
      },
      async (db, recordQuery) => {
        const start = Date.now();
        const period = currentPeriodRange();
        // Calendar-month boundaries for SUM/COUNT queries.
        const now = new Date();
        const periodStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
        const periodEndIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

        recordQuery({ op: "select", table: "tenants" });
        const { data: tenants } = await db
          .from("tenants")
          .select("id, tier_id, seat_count, billing_period, status")
          .in("status", ["active", "sandbox"])
          .limit(5000);

        let tenantsProcessed = 0;
        const drifts: DriftRecord[] = [];

        for (const t of ((tenants ?? []) as Array<{
          id: string;
          tier_id?: string | null;
          seat_count?: number;
          billing_period?: "monthly" | "annual";
          status: string;
        }>)) {
          tenantsProcessed++;

          // Tier code lookup.
          let tier_code: TenantRevenueSnapshot["tier_code"] = "byo_research";
          if (t.tier_id) {
            const { data: td } = await db.from("tier_definitions").select("code").eq("id", t.tier_id).maybeSingle();
            const c = (td as { code?: string } | null)?.code;
            if (c && TIER_CODES.has(c)) tier_code = c as TenantRevenueSnapshot["tier_code"];
          }
          const tenantSnapshot: TenantRevenueSnapshot & { tenant_id: string } = {
            tenant_id: t.id,
            tier_code,
            seat_count: t.seat_count ?? 1,
            billing_period: t.billing_period ?? "monthly",
          };

          // Pull current real-time metrics + RAG quota row.
          const { data: metricsRow } = await db
            .from("tenant_usage_metrics")
            .select("id, ai_cost_cents, chat_messages_count, email_sent_count, group_invitees_count")
            .eq("tenant_id", t.id)
            .eq("billing_period", period)
            .maybeSingle();
          const rt = metricsRow as
            | { id: string; ai_cost_cents: string | number; chat_messages_count: number; email_sent_count: number; group_invitees_count: number }
            | null;

          // ── AI cost: SUM ai_call_log.cost_estimate_cents ──
          const { data: aiSumRows } = await db
            .from("ai_call_log")
            .select("cost_estimate_cents")
            .eq("tenant_id", t.id)
            .gte("created_at", periodStartIso)
            .lt("created_at", periodEndIso)
            .limit(50000);
          let aiTrue = 0n;
          for (const r of ((aiSumRows ?? []) as Array<{ cost_estimate_cents: string | number }>)) {
            aiTrue += BigInt(r.cost_estimate_cents);
          }
          const aiRt = BigInt(rt?.ai_cost_cents ?? 0);
          if (rt && (aiTrue > aiRt ? aiTrue - aiRt : aiRt - aiTrue) > 1n) {
            await db.from("tenant_usage_metrics").update({ ai_cost_cents: aiTrue.toString() }).eq("id", rt.id);
            drifts.push({ tenant_id: t.id, dimension: "ai_cost", real_time_value: aiRt, recomputed_value: aiTrue });
          }

          // ── Chat volume: count assistant messages in this tenant's conversations ──
          const { data: chatCountRows } = await db
            .from("messages")
            .select("id, conversations!inner(tenant_id)")
            .eq("role", "assistant")
            .gte("created_at", periodStartIso)
            .lt("created_at", periodEndIso)
            .eq("conversations.tenant_id", t.id)
            .limit(50000);
          const chatTrue = Array.isArray(chatCountRows) ? chatCountRows.length : 0;
          const chatRt = rt?.chat_messages_count ?? 0;
          if (rt && Math.abs(chatTrue - chatRt) > 0) {
            await db.from("tenant_usage_metrics").update({ chat_messages_count: chatTrue }).eq("id", rt.id);
            drifts.push({
              tenant_id: t.id,
              dimension: "chat_volume",
              real_time_value: BigInt(chatRt),
              recomputed_value: BigInt(chatTrue),
            });
          }

          // ── Email volume: count email_log rows not suppressed/failed ──
          const { data: emailCountRows } = await db
            .from("email_log")
            .select("id, status")
            .eq("tenant_id", t.id)
            .gte("created_at", periodStartIso)
            .lt("created_at", periodEndIso)
            .limit(50000);
          const emailTrue = Array.isArray(emailCountRows)
            ? emailCountRows.filter((r: { status: string }) => r.status !== "suppressed" && r.status !== "failed").length
            : 0;
          const emailRt = rt?.email_sent_count ?? 0;
          if (rt && Math.abs(emailTrue - emailRt) > 0) {
            await db.from("tenant_usage_metrics").update({ email_sent_count: emailTrue }).eq("id", rt.id);
            drifts.push({
              tenant_id: t.id,
              dimension: "email_volume",
              real_time_value: BigInt(emailRt),
              recomputed_value: BigInt(emailTrue),
            });
          }

          // ── Group invite: count invitations created ──
          const { data: inviteRows } = await db
            .from("invitations")
            .select("id, group_id, groups!inner(tenant_id)")
            .gte("created_at", periodStartIso)
            .lt("created_at", periodEndIso)
            .eq("groups.tenant_id", t.id)
            .limit(50000);
          const inviteTrue = Array.isArray(inviteRows) ? inviteRows.length : 0;
          const inviteRt = rt?.group_invitees_count ?? 0;
          if (rt && Math.abs(inviteTrue - inviteRt) > 0) {
            await db.from("tenant_usage_metrics").update({ group_invitees_count: inviteTrue }).eq("id", rt.id);
            drifts.push({
              tenant_id: t.id,
              dimension: "group_invite",
              real_time_value: BigInt(inviteRt),
              recomputed_value: BigInt(inviteTrue),
            });
          }

          // ── RAG: recompute promoted_chunks_count from rag_global_promotions ──
          //   The chunk count (current_tenant_chunks_count) is RAG-side and
          //   would need a service-to-service call to the RAG service. That's
          //   deferred — TODO(rag-service-count).
          const { data: promoCountRows } = await db
            .from("rag_global_promotions")
            .select("id")
            .eq("tenant_id", t.id)
            .is("demoted_at", null);
          const promotedTrue = Array.isArray(promoCountRows) ? promoCountRows.length : 0;
          const { data: quotaRow } = await db
            .from("tenant_rag_quotas")
            .select("promoted_chunks_count")
            .eq("tenant_id", t.id)
            .maybeSingle();
          const promotedRt = Number((quotaRow as { promoted_chunks_count?: number } | null)?.promoted_chunks_count ?? 0);
          if (Math.abs(promotedTrue - promotedRt) > 0) {
            if (quotaRow) {
              await db.from("tenant_rag_quotas").update({ promoted_chunks_count: promotedTrue }).eq("tenant_id", t.id);
            } else {
              await db.from("tenant_rag_quotas").insert({
                tenant_id: t.id,
                base_cap: 0,
                promoted_chunks_count: promotedTrue,
                current_tenant_chunks_count: 0,
              });
            }
            drifts.push({
              tenant_id: t.id,
              dimension: "rag_cap",
              real_time_value: BigInt(promotedRt),
              recomputed_value: BigInt(promotedTrue),
            });
          }

          // Re-evaluate state machine for each dimension after corrections.
          void checkStateTransitionIfNeeded({ db, tenant: tenantSnapshot, dimension: "ai_cost", metric_value: aiTrue });
          void checkStateTransitionIfNeeded({ db, tenant: tenantSnapshot, dimension: "chat_volume", metric_value: BigInt(chatTrue) });
          void checkStateTransitionIfNeeded({ db, tenant: tenantSnapshot, dimension: "email_volume", metric_value: BigInt(emailTrue) });
          void checkStateTransitionIfNeeded({ db, tenant: tenantSnapshot, dimension: "group_invite", metric_value: BigInt(inviteTrue) });
        }

        await logDriftIfAny(drifts);
        recordQuery({ op: "insert", table: "abuse_recompute_drift_log", row_count: drifts.length });

        return {
          tenants_processed: tenantsProcessed,
          drift_records: drifts.length,
          elapsed_ms: Date.now() - start,
        };
      },
    );
  },
);

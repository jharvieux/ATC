// §27.7 — Abuse monitoring dashboard summary endpoint.
//
// Aggregates counts used by the 5 dashboard tabs in a single round-trip.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "abuse")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const summary = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "abuse_threshold_breach_review", operation: "abuse_dashboard_summary" },
      async (db, recordQuery) => {
        const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const today = new Date().toISOString().slice(0, 10);

        // Tenants currently at non-ok state in any dimension.
        const { data: atRisk } = await db
          .from("tenant_usage_metrics")
          .select("tenant_id, ai_cost_limit_state, chat_volume_limit_state, email_volume_limit_state, group_invite_limit_state, billing_period")
          .or("ai_cost_limit_state.neq.ok,chat_volume_limit_state.neq.ok,email_volume_limit_state.neq.ok,group_invite_limit_state.neq.ok")
          .limit(500);
        recordQuery({ op: "select", table: "tenant_usage_metrics", row_count: atRisk?.length ?? 0 });

        // RAG-cap risk.
        const { data: ragAtRisk } = await db
          .from("tenant_rag_quotas")
          .select("tenant_id, rag_state, promoted_chunks_count, current_tenant_chunks_count, base_cap")
          .neq("rag_state", "ok")
          .limit(500);
        recordQuery({ op: "select", table: "tenant_rag_quotas", row_count: ragAtRisk?.length ?? 0 });

        // Pending override requests.
        const { data: pendingRequests } = await db
          .from("tenant_override_requests")
          .select("id")
          .eq("status", "pending");
        recordQuery({ op: "select", table: "tenant_override_requests", row_count: pendingRequests?.length ?? 0 });

        // Active overrides (effective_to in future).
        const { data: activeOverrides } = await db
          .from("tenant_usage_overrides")
          .select("id, tenant_id, dimension, threshold_value, effective_to")
          .or(`effective_to.is.null,effective_to.gt.${today}`);
        recordQuery({ op: "select", table: "tenant_usage_overrides", row_count: activeOverrides?.length ?? 0 });

        // Recent drift records (last 7d).
        const { data: drift } = await db
          .from("abuse_recompute_drift_log")
          .select("id, tenant_id, dimension, drift_amount, detected_at")
          .gte("detected_at", sinceIso)
          .order("detected_at", { ascending: false })
          .limit(50);
        recordQuery({ op: "select", table: "abuse_recompute_drift_log", row_count: drift?.length ?? 0 });

        // Recent state transitions (last 7d).
        const { data: transitions } = await db
          .from("usage_limit_events")
          .select("id, tenant_id, dimension, from_state, to_state, metric_value, threshold_crossed, triggered_at")
          .gte("triggered_at", sinceIso)
          .order("triggered_at", { ascending: false })
          .limit(100);
        recordQuery({ op: "select", table: "usage_limit_events", row_count: transitions?.length ?? 0 });

        return {
          tenants_at_risk: atRisk ?? [],
          rag_at_risk: ragAtRisk ?? [],
          pending_requests_count: pendingRequests?.length ?? 0,
          active_overrides: activeOverrides ?? [],
          recent_drift: drift ?? [],
          recent_transitions: transitions ?? [],
        };
      },
    );
    return Response.json({ ok: true, summary });
  } catch (err) {
    return dbErrorResponse(err);
  }
}

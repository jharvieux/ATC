// §27 — Per-tenant abuse detail (for the admin tenant-drilldown view).

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request, ctx: { params: Promise<{ tenant_id: string }> }): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "abuse")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const { tenant_id } = await ctx.params;

  try {
    const detail = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "abuse_threshold_breach_review", operation: `abuse_tenant_detail:${tenant_id}` },
      async (db, recordQuery) => {
        const today = new Date().toISOString().slice(0, 10);

        const { data: metricsRows } = await db
          .from("tenant_usage_metrics")
          .select("billing_period, ai_cost_cents, chat_messages_count, email_sent_count, group_invitees_count, ai_cost_limit_state, chat_volume_limit_state, email_volume_limit_state, group_invite_limit_state, ai_cost_state_changed_at, chat_volume_state_changed_at, email_volume_state_changed_at, group_invite_state_changed_at")
          .eq("tenant_id", tenant_id)
          .order("billing_period", { ascending: false })
          .limit(6);
        recordQuery({ op: "select", table: "tenant_usage_metrics" });

        const { data: rag } = await db
          .from("tenant_rag_quotas")
          .select("base_cap, promoted_chunks_count, current_tenant_chunks_count, rag_state, rag_state_changed_at")
          .eq("tenant_id", tenant_id)
          .maybeSingle();
        recordQuery({ op: "select", table: "tenant_rag_quotas" });

        const { data: overrides } = await db
          .from("tenant_usage_overrides")
          .select("id, dimension, tier_override, threshold_value, effective_from, effective_to, reason, created_at, expiry_notified_at")
          .eq("tenant_id", tenant_id)
          .order("created_at", { ascending: false })
          .limit(50);
        recordQuery({ op: "select", table: "tenant_usage_overrides" });
        const active = (overrides ?? []).filter((o) => {
          const e = (o as { effective_to: string | null }).effective_to;
          return !e || e > today;
        });

        const { data: events } = await db
          .from("usage_limit_events")
          .select("id, dimension, from_state, to_state, metric_value, threshold_crossed, triggered_at, notification_sent_to, resolution_action")
          .eq("tenant_id", tenant_id)
          .order("triggered_at", { ascending: false })
          .limit(50);
        recordQuery({ op: "select", table: "usage_limit_events" });

        const { data: requests } = await db
          .from("tenant_override_requests")
          .select("id, dimension, requested_threshold_kind, current_state, reason, requested_at, status, reviewed_at, deny_reason, resulting_override_id")
          .eq("tenant_id", tenant_id)
          .order("requested_at", { ascending: false })
          .limit(50);
        recordQuery({ op: "select", table: "tenant_override_requests" });

        return {
          tenant_id,
          metrics_history: metricsRows ?? [],
          rag,
          overrides: overrides ?? [],
          active_overrides: active,
          recent_events: events ?? [],
          recent_requests: requests ?? [],
        };
      },
    );
    return Response.json({ ok: true, detail });
  } catch (err) {
    return dbErrorResponse(err);
  }
}

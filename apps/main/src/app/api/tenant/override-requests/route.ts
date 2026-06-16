// §27.11 — Tenant-initiated override request endpoint.
//
// POST /api/tenant/override-requests
//   Body: { dimension, requested_threshold_kind, reason, current_state }
// GET  /api/tenant/override-requests
//   Lists this tenant's requests.
//
// RLS scopes inserts/reads via auth_user_in_tenant on tenant_override_requests.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

const DIMENSIONS = new Set(["ai_cost", "rag_cap", "chat_volume", "email_volume", "group_invite"]);
const THRESHOLD_KINDS = new Set(["soft1", "soft2", "hard", "base_cap"]);

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "TenantOverrideRequest",
      action: "create",
    });

    let body: unknown;
    try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
    const b = (body ?? {}) as Record<string, unknown>;
    const dimension = String(b.dimension ?? "");
    const requested_threshold_kind = typeof b.requested_threshold_kind === "string" ? b.requested_threshold_kind : null;
    const reason = String(b.reason ?? "");
    const current_state = String(b.current_state ?? "");

    if (!DIMENSIONS.has(dimension) || reason.length < 5 || current_state.length === 0) {
      return Response.json({ error: "invalid_input" }, { status: 400 });
    }
    if (requested_threshold_kind && !THRESHOLD_KINDS.has(requested_threshold_kind)) {
      return Response.json({ error: "invalid_threshold_kind" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("tenant_override_requests")
      .insert({
        tenant_id: ctx.tenant_id,
        dimension,
        requested_threshold_kind,
        current_state,
        reason,
        requested_by_user_id: user.id,
      })
      .select("id, requested_at, status")
      .single();
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json({ ok: true, request: data });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "TenantOverrideRequest",
      action: "list",
    });
    const db = tenantClient(ctx);
    const { data } = await db
      .from("tenant_override_requests")
      .select("id, dimension, requested_threshold_kind, current_state, reason, requested_at, status, reviewed_at, deny_reason, resulting_override_id")
      .order("requested_at", { ascending: false })
      .limit(100);
    return Response.json({ ok: true, items: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

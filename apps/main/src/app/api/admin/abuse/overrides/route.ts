// §27.11 — Platform-admin override create/list endpoint.
//
// POST /api/admin/abuse/overrides
//   Body: { tenant_id, dimension, tier_override, threshold_value,
//           effective_to?, reason, resulting_request_id? }
//   On success, also re-evaluates state for that dimension so the tenant
//   immediately benefits from the new cap.
//
// GET /api/admin/abuse/overrides?tenant_id=...
//   Lists active overrides for a tenant.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";

const DIMENSIONS = new Set(["ai_cost", "rag_cap", "chat_volume", "email_volume", "group_invite"]);
const TIER_OVERRIDES = new Set(["soft1", "soft2", "hard", "base_cap"]);

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultExpiryDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;
  const tenant_id = String(b.tenant_id ?? "");
  const dimension = String(b.dimension ?? "");
  const tier_override = String(b.tier_override ?? "");
  const threshold_value = Number(b.threshold_value ?? NaN);
  const effective_to = typeof b.effective_to === "string" ? b.effective_to : undefined;
  const reason = String(b.reason ?? "");
  const resulting_request_id = typeof b.resulting_request_id === "string" ? b.resulting_request_id : null;

  if (!tenant_id || !DIMENSIONS.has(dimension) || !TIER_OVERRIDES.has(tier_override) || !Number.isFinite(threshold_value) || threshold_value < 0 || reason.length < 5) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const defaultDurationDays = Number(process.env.ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS ?? 30);
  const expiry = effective_to ?? defaultExpiryDate(defaultDurationDays);

  try {
    const created = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "abuse_override_create", operation: `abuse_override_create:${tenant_id}:${dimension}` },
      async (db, recordQuery) => {
        const { data, error } = await db
          .from("tenant_usage_overrides")
          .insert({
            tenant_id,
            dimension,
            tier_override,
            threshold_value: threshold_value.toString(),
            effective_from: todayDate(),
            effective_to: expiry,
            reason,
            approved_by_user_id: adminUserId,
          })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        const overrideId = (data as { id: string }).id;
        recordQuery({ op: "insert", table: "tenant_usage_overrides", row_count: 1 });

        // If linked to a pending request, mark it approved.
        if (resulting_request_id) {
          await safeAwait(db
            .from("tenant_override_requests")
            .update({
              status: "approved",
              reviewed_by_user_id: adminUserId,
              reviewed_at: new Date().toISOString(),
              resulting_override_id: overrideId,
            })
            .eq("id", resulting_request_id)
            .eq("status", "pending"), "tenant_override_requests.update");
          recordQuery({ op: "update", table: "tenant_override_requests" });
        }
        return { id: overrideId, effective_to: expiry };
      },
    );

    // Fire subscription_changed-style recompute event so state machine
    // reflects the new cap on next read.
    const { inngest } = await import("@/inngest/client");
    await inngest.send({
      name: "tenant.subscription_changed",
      data: { tenant_id, change: "tier" },
    });

    return Response.json({ ok: true, override: created });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const tenant_id = new URL(req.url).searchParams.get("tenant_id");
  if (!tenant_id) return Response.json({ error: "tenant_id required" }, { status: 400 });

  try {
    const items = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "abuse_threshold_breach_review", operation: `abuse_override_list:${tenant_id}` },
      async (db, recordQuery) => {
        const { data } = await db
          .from("tenant_usage_overrides")
          .select("id, dimension, tier_override, threshold_value, effective_from, effective_to, reason, approved_by_user_id, created_at, expiry_notified_at")
          .eq("tenant_id", tenant_id)
          .order("created_at", { ascending: false })
          .limit(200);
        recordQuery({ op: "select", table: "tenant_usage_overrides", row_count: data?.length ?? 0 });
        return data ?? [];
      },
    );
    return Response.json({ ok: true, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

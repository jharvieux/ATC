// §27.11 — Revoke an active override.
//
// DELETE /api/admin/abuse/overrides/[id]
//   Sets effective_to = today so the cap reverts on next state check.
//   Also fires tenant.subscription_changed so the state recompute job
//   recomputes immediately.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const { id } = await ctx.params;
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  try {
    const tenantId = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "abuse_override_revoke",
        operation: `abuse_override_revoke:${id}`,
        reason_detail: `override_id=${id};revoked_via=admin_api`,
      },
      async (db, recordQuery) => {
        const { data: row } = await db
          .from("tenant_usage_overrides")
          .select("id, tenant_id, effective_to")
          .eq("id", id)
          .maybeSingle();
        const r = row as { id: string; tenant_id: string; effective_to: string | null } | null;
        if (!r) throw new Error("override_not_found");

        const today = new Date().toISOString().slice(0, 10);
        await safeAwait(db
          .from("tenant_usage_overrides")
          .update({ effective_to: today, expiry_notified_at: new Date().toISOString() })
          .eq("id", id), "tenant_usage_overrides.update");
        recordQuery({ op: "update", table: "tenant_usage_overrides", row_count: 1 });
        return r.tenant_id;
      },
    );

    const { inngest } = await import("@/inngest/client");
    await inngest.send({
      name: "tenant.subscription_changed",
      data: { tenant_id: tenantId, change: "tier" },
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

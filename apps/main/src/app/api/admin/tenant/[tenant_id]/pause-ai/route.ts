// §10.6 Per-tenant AI pause
//
// POST /api/admin/tenant/:tenant_id/pause-ai
//
// Sets tenants.status = 'suspended' which cuts off customer-facing chat
// via the existing tenant-suspended check. Per §10.6 semantics: "per-tenant
// pause uses the existing tenants.status field — 'suspended' already exists;
// no new column needed."
//
// Requires platform-admin. Wraps in withPlatformAdminAudit with reason
// "ai_kill_switch_tenant_pause".

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

export async function POST(req: Request, props: { params: Promise<{ tenant_id: string }> }): Promise<Response> {
  const params = await props.params;
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const { tenant_id } = params;
  if (!tenant_id) {
    return Response.json({ error: "tenant_id required" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const reason =
    typeof body === "object" && body !== null
      ? ((body as Record<string, unknown>).reason as string | undefined)
      : undefined;

  try {
    await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "ai_kill_switch_tenant_pause",
        operation: "tenant_ai_pause",
        reason_detail: reason ?? "manual_tenant_pause",
      },
      async (db) => {
        const { error } = await db
          .from("tenants")
          .update({ status: "suspended" })
          .eq("id", tenant_id);

        if (error) throw new Error(error.message);
      },
    );

    return Response.json({ ok: true, tenant_id, status: "suspended" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal_error";
    return Response.json({ error: message }, { status: 500 });
  }
}

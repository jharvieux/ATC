// §17.10 — CCPA deletion undo.
// POST: clear users.deleted_at if within the 30-day grace period.
//
// 2026-05-25 — tenant-scoped per audit finding Auth #4. Restore matches
// the per-tenant delete shape: undoing on tenant A only clears tenant A.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { authenticateUser } from "@/lib/auth/authenticate-user";

export async function POST(req: Request): Promise<Response> {
  const authed = await authenticateUser(req);
  if (!authed) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const authUserId = authed.authUserId;

  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  if (!tenantId || tenantId === "platform") {
    return Response.json({ error: "tenant_unresolved" }, { status: 400 });
  }

  const db = createServiceRoleClient();

  const { data: userRow } = await db
    .from("users")
    .select("id, deleted_at")
    .eq("auth_user_id", authUserId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!userRow) return Response.json({ error: "user_not_found" }, { status: 404 });

  const typedUser = userRow as { id: string; deleted_at: string | null };

  if (!typedUser.deleted_at) {
    return Response.json({ error: "not_deleted" }, { status: 409 });
  }

  const deletedAt = new Date(typedUser.deleted_at).getTime();
  const gracePeriodEnd = deletedAt + 30 * 24 * 60 * 60 * 1000;
  if (Date.now() >= gracePeriodEnd) {
    return Response.json({ error: "grace_period_expired" }, { status: 410 });
  }

  const { error: updateErr } = await db
    .from("users")
    .update({ deleted_at: null })
    .eq("auth_user_id", authUserId)
    .eq("tenant_id", tenantId);

  if (updateErr) return dbErrorResponse(updateErr);

  return Response.json({ ok: true });
}

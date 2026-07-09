// §17.10 — CCPA data deletion request.
// POST: user must confirm by typing their own email address.
// Sets users.deleted_at and schedules a purge Inngest job at +30 days.
//
// 2026-05-25 — tenant-scoped per audit finding Auth #4. A single Supabase
// auth user can have rows in multiple tenants (UNIQUE(tenant_id, auth_user_id));
// without scoping, clicking "delete my account" on tenant A's app silently
// flagged the user's tenant B row too. The middleware now reliably propagates
// x-resolved-tenant-id to handlers (per #164), so we filter by it.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "@/inngest/client";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { authenticateUser } from "@/lib/auth/authenticate-user";

interface DeleteBody {
  email_confirmation: string;
}

export async function POST(req: Request): Promise<Response> {
  const authed = await authenticateUser(req);
  if (!authed) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const authUserId = authed.authUserId;

  // Tenant scope (audit Auth #4): a single auth user can have rows in
  // multiple tenants; clicking "delete my account" on tenant A's app must
  // not silently flag the user's tenant B row. The middleware reliably
  // injects x-resolved-tenant-id (#164), so we filter by it.
  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  if (!tenantId || tenantId === "platform") {
    return Response.json({ error: "tenant_unresolved" }, { status: 400 });
  }

  let body: DeleteBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // Confirm email matches.
  const userEmail = authed.email ?? "";
  if (!body.email_confirmation || body.email_confirmation.trim().toLowerCase() !== userEmail.toLowerCase()) {
    return Response.json({ error: "email_confirmation_mismatch" }, { status: 422 });
  }

  const db = createServiceRoleClient();

  // Check not already deleted — scoped to current tenant.
  const { data: userRow } = await db
    .from("users")
    .select("id, deleted_at")
    .eq("auth_user_id", authUserId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!userRow) return Response.json({ error: "user_not_found" }, { status: 404 });

  const typedUser = userRow as { id: string; deleted_at: string | null };
  if (typedUser.deleted_at) {
    return Response.json({ error: "already_deleted" }, { status: 409 });
  }

  const deletedAt = new Date().toISOString();
  const purgeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Set deleted_at — starts the 30-day grace period. Tenant-scoped.
  const { error: updateErr } = await db
    .from("users")
    .update({ deleted_at: deletedAt })
    .eq("auth_user_id", authUserId)
    .eq("tenant_id", tenantId);

  if (updateErr) return dbErrorResponse(updateErr);

  // Schedule purge job after 30 days.
  await inngest.send({
    name: "user.data_purge_scheduled",
    data: {
      auth_user_id: authUserId,
      user_id: typedUser.id,
      deleted_at: deletedAt,
      purge_at: purgeAt,
    },
  });

  return Response.json({ ok: true, deleted_at: deletedAt, purge_at: purgeAt });
}

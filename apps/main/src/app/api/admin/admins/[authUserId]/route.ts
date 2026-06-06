// §26 — Platform-admin management: change role / remove (superadmin only).
//
//   PATCH  /api/admin/admins/:authUserId  → body { role } — change an admin's role
//   DELETE /api/admin/admins/:authUserId  → remove an admin
//
// You cannot change/remove yourself (route-level — the RPC doesn't know the
// caller). The existence + last-superadmin checks run INSIDE the atomic
// SECURITY DEFINER RPCs (`admin_change_platform_role` / `admin_remove_platform_admin`,
// #813), which serialize via a transaction-scoped advisory lock — no TOCTOU
// between the count and the mutation. Each writes one audit_log row.

import { assertSuperadmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { isPlatformAdminRole } from "@/lib/auth/platform-admin-roles";

// Maps the RPC's status string to an HTTP response.
function mapResult(status: string): Response {
  if (status === "not_found") {
    return Response.json({ error: "admin_not_found" }, { status: 404 });
  }
  if (status === "last_superadmin") {
    return Response.json(
      { error: "last_superadmin", detail: "Cannot demote or remove the only superadmin. Promote another admin to superadmin first." },
      { status: 409 },
    );
  }
  return Response.json({ ok: true }, { status: 200 });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ authUserId: string }> },
): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertSuperadmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const { authUserId } = await params;

  let body: { role?: string };
  try {
    body = (await req.json()) as { role?: string };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const role = typeof body.role === "string" ? body.role : "";
  if (!isPlatformAdminRole(role)) {
    return Response.json({ error: "invalid_role" }, { status: 400 });
  }
  if (authUserId === adminUserId) {
    return Response.json(
      { error: "cannot_change_self", detail: "You can't change your own role. Have another superadmin do it." },
      { status: 409 },
    );
  }

  try {
    const status = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "platform_admin_management", operation: "admins.update_role" },
      async (db, recordQuery) => {
        recordQuery({ op: "rpc", table: "platform_admins", rpc_name: "admin_change_platform_role" });
        return (await safeAwait(
          db.rpc("admin_change_platform_role", { p_target: authUserId, p_new_role: role }),
          "admin_change_platform_role",
        )) as string;
      },
    );
    return mapResult(status);
  } catch (e) {
    console.error("[admin/admins:PATCH] failed:", e);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ authUserId: string }> },
): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertSuperadmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const { authUserId } = await params;

  if (authUserId === adminUserId) {
    return Response.json(
      { error: "cannot_remove_self", detail: "You can't remove yourself. Have another superadmin do it." },
      { status: 409 },
    );
  }

  try {
    const status = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "platform_admin_management", operation: "admins.remove" },
      async (db, recordQuery) => {
        recordQuery({ op: "rpc", table: "platform_admins", rpc_name: "admin_remove_platform_admin" });
        return (await safeAwait(
          db.rpc("admin_remove_platform_admin", { p_target: authUserId }),
          "admin_remove_platform_admin",
        )) as string;
      },
    );
    return mapResult(status);
  } catch (e) {
    console.error("[admin/admins:DELETE] failed:", e);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

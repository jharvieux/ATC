// §26 — Platform-admin management: change role / remove (superadmin only).
//
//   PATCH  /api/admin/admins/:authUserId  → body { role } — change an admin's role
//   DELETE /api/admin/admins/:authUserId  → remove an admin
//
// Guardrails (both): you cannot change/remove yourself (avoids locking yourself
// out), and you cannot demote or remove the LAST superadmin (avoids locking
// everyone out of admin management). Each writes one audit_log row.

import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSuperadmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { isPlatformAdminRole } from "@/lib/auth/platform-admin-roles";

const ADMIN_COLS = "auth_user_id, role, email, notes, created_at, created_by_auth_user_id";

async function fetchTargetRole(db: SupabaseClient, authUserId: string): Promise<string | null> {
  const row = await safeAwait(
    db.from("platform_admins").select("role").eq("auth_user_id", authUserId).maybeSingle(),
    "platform_admins.fetch_target",
  );
  return (row as { role: string } | null)?.role ?? null;
}

// True if `superadmin` count is ≤ 1 — i.e. demoting/removing a superadmin now
// would leave nobody who can manage admins.
async function isLastSuperadmin(db: SupabaseClient): Promise<boolean> {
  const { count, error } = await db
    .from("platform_admins")
    .select("auth_user_id", { count: "exact", head: true })
    .eq("role", "superadmin");
  if (error) throw new Error(`platform_admins.superadmin_count failed: ${error.message}`);
  return (count ?? 0) <= 1;
}

type MutationResult =
  | { kind: "not_found" }
  | { kind: "last_superadmin" }
  | { kind: "ok"; admin?: unknown };

function toResponse(result: MutationResult): Response {
  if (result.kind === "not_found") {
    return Response.json({ error: "admin_not_found" }, { status: 404 });
  }
  if (result.kind === "last_superadmin") {
    return Response.json(
      { error: "last_superadmin", detail: "Cannot demote or remove the only superadmin. Promote another admin to superadmin first." },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, admin: result.admin }, { status: 200 });
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
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "platform_admin_management", operation: "admins.update_role" },
      async (db, recordQuery): Promise<MutationResult> => {
        const currentRole = await fetchTargetRole(db, authUserId);
        if (currentRole === null) return { kind: "not_found" };
        if (currentRole === "superadmin" && role !== "superadmin" && (await isLastSuperadmin(db))) {
          return { kind: "last_superadmin" };
        }
        recordQuery({ op: "update", table: "platform_admins" });
        const updated = await safeAwait(
          db.from("platform_admins").update({ role }).eq("auth_user_id", authUserId).select(ADMIN_COLS).single(),
          "platform_admins.update_role",
        );
        return { kind: "ok", admin: updated };
      },
    );
    return toResponse(result);
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
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "platform_admin_management", operation: "admins.remove" },
      async (db, recordQuery): Promise<MutationResult> => {
        const currentRole = await fetchTargetRole(db, authUserId);
        if (currentRole === null) return { kind: "not_found" };
        if (currentRole === "superadmin" && (await isLastSuperadmin(db))) {
          return { kind: "last_superadmin" };
        }
        recordQuery({ op: "delete", table: "platform_admins" });
        // .select() confirms a row was actually removed — guards the narrow
        // window where the row was deleted between the fetch above and here.
        const removed = await safeAwait(
          db.from("platform_admins").delete().eq("auth_user_id", authUserId).select("auth_user_id"),
          "platform_admins.delete",
        );
        if (!Array.isArray(removed) || removed.length === 0) return { kind: "not_found" };
        return { kind: "ok" };
      },
    );
    return toResponse(result);
  } catch (e) {
    console.error("[admin/admins:DELETE] failed:", e);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

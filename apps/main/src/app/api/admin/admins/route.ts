// §26 — Platform-admin management API.
//
//   GET  /api/admin/admins  → list platform admins (any platform admin; read-only)
//   POST /api/admin/admins  → add an admin by email (superadmin only)
//
// Listing is open to any platform admin so reviewer/finance/support can SEE who
// has access; mutations are superadmin-gated (assertSuperadmin) — the first
// per-role enforcement on the platform side. Every operation writes one
// audit_log row via withPlatformAdminAudit.

import {
  assertPlatformAdmin,
  assertSuperadmin,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { isPlatformAdminRole } from "@/lib/auth/platform-admin-roles";

interface AdminRow {
  auth_user_id: string;
  role: string;
  email: string | null;
  notes: string | null;
  created_at: string;
  created_by_auth_user_id: string | null;
}

const ADMIN_COLS = "auth_user_id, role, email, notes, created_at, created_by_auth_user_id";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  let callerRole: string;
  try {
    const ctx = await assertPlatformAdmin(req);
    adminUserId = ctx.admin_user_id;
    callerRole = ctx.role;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const admins = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "platform_admin_management", operation: "admins.list" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "platform_admins" });
        const rows = await safeAwait(
          db.from("platform_admins").select(ADMIN_COLS).order("created_at", { ascending: true }),
          "platform_admins.list",
        );
        return (rows ?? []) as AdminRow[];
      },
    );
    return Response.json({
      admins,
      caller_id: adminUserId,
      caller_role: callerRole,
      can_manage: callerRole === "superadmin",
    });
  } catch (e) {
    console.error("[admin/admins:GET] failed:", e);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

interface AddBody {
  email?: string;
  role?: string;
  notes?: string;
}

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertSuperadmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: AddBody;
  try {
    body = (await req.json()) as AddBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const role = typeof body.role === "string" ? body.role : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;

  if (!email) return Response.json({ error: "email_required" }, { status: 400 });
  if (!isPlatformAdminRole(role)) {
    return Response.json(
      { error: "invalid_role", detail: "role must be superadmin | reviewer | finance | support" },
      { status: 400 },
    );
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "platform_admin_management", operation: "admins.add" },
      async (db, recordQuery): Promise<
        { kind: "no_user" } | { kind: "exists" } | { kind: "ok"; admin: AdminRow }
      > => {
        // Resolve the email to an existing auth account via the locked-down RPC.
        recordQuery({ op: "rpc", table: "auth.users", rpc_name: "admin_lookup_auth_user_by_email" });
        const targetId = await safeAwait(
          db.rpc("admin_lookup_auth_user_by_email", { p_email: email }),
          "admin_lookup_auth_user_by_email",
        );
        if (!targetId || typeof targetId !== "string") return { kind: "no_user" };

        const existing = await safeAwait(
          db.from("platform_admins").select("auth_user_id").eq("auth_user_id", targetId).maybeSingle(),
          "platform_admins.exists_check",
        );
        if (existing) return { kind: "exists" };

        recordQuery({ op: "insert", table: "platform_admins" });
        const inserted = await safeAwait(
          db
            .from("platform_admins")
            .insert({ auth_user_id: targetId, role, email, notes, created_by_auth_user_id: adminUserId })
            .select(ADMIN_COLS)
            .single(),
          "platform_admins.insert",
        );
        return { kind: "ok", admin: inserted as unknown as AdminRow };
      },
    );

    if (result.kind === "no_user") {
      return Response.json(
        {
          error: "user_not_found",
          detail: "No account with that email has signed in yet. Have them sign in once, then add them.",
        },
        { status: 404 },
      );
    }
    if (result.kind === "exists") {
      return Response.json({ error: "already_admin" }, { status: 409 });
    }
    return Response.json({ ok: true, admin: result.admin }, { status: 201 });
  } catch (e) {
    console.error("[admin/admins:POST] failed:", e);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

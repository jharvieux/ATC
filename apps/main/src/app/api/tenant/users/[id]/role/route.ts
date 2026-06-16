// §26.2 — Update a tenant member's role.
//
// Owner-only per permission-grants.ts (team_members:update_role). Other
// guardrails:
//   - The target user must be in the current tenant (RLS via tenantClient
//     plus an explicit .eq(tenant_id) on the update).
//   - You cannot demote yourself (avoids the "lock yourself out" footgun;
//     transferring ownership uses a future dedicated endpoint).
//   - Role must be one of tenant_owner | agent | viewer.

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { isKnownRole } from "@/lib/auth/permission-grants";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface Body {
  role?: string;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "team_members",
      action: "update_role",
    });
    const { id } = await params;

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!body.role || !isKnownRole(body.role)) {
      return Response.json(
        { error: "invalid_role", detail: "role must be tenant_owner | agent | viewer" },
        { status: 400 },
      );
    }

    if (id === user.id) {
      return Response.json(
        {
          error: "cannot_demote_self",
          detail:
            "You cannot change your own role. Have another owner do it, or use the (future) ownership-transfer endpoint.",
        },
        { status: 409 },
      );
    }

    const db = tenantClient(ctx);

    const { data: updated, error } = await db
      .from("users")
      .update({ role: body.role })
      .eq("id", id)
      .select("id, role")
      .maybeSingle();

    if (error) {
      return dbErrorResponse(error);
    }
    if (!updated) {
      return Response.json({ error: "user_not_found_in_tenant" }, { status: 404 });
    }

    return Response.json({ ok: true, user: updated });
  } catch (err) {
    return respondToAuthError(err);
  }
}

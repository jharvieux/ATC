// §26.2 — List members of the current tenant.
//
// Used by the /settings/users page so tenant owners can see who's in the
// tenant and what role each user has. Read access granted to all active
// members (viewer/agent/tenant_owner) per permission-grants.ts.

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface MemberRow {
  id: string;
  auth_user_id: string;
  email: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string;
  status: string;
  last_signed_in_at: string | null;
  created_at: string;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "team_members",
      action: "list",
    });
    const db = tenantClient(ctx);

    const { data, error } = await db
      .from("users")
      .select(
        "id, auth_user_id, email, display_name, first_name, last_name, role, status, last_signed_in_at, created_at",
      )
      .eq("status", "active")
      .order("created_at", { ascending: true });

    if (error) {
      return dbErrorResponse();
    }

    return Response.json({
      members: (data ?? []) as MemberRow[],
      caller_role: user.role,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

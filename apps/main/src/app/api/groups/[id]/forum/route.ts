// §19 — Resolve the forum for a group (1:1 via forums.group_id UNIQUE).
//
// GET /api/groups/:id/forum
// Returns { forum_id, is_locked, is_coordinator } so the client can route
// subsequent thread + message reads without a separate forum-lookup step.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { forumCoordinatorId } from "@/lib/forums/permissions";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "groups", action: "read" });
    const db = tenantClient(ctx);
    const { id: groupId } = await params;

    const { data: forum, error } = await db
      .from("forums")
      // #1190: coordinator lives on the linked group, not on forums.
      .select("id, is_locked, groups(coordinator_user_id)")
      .eq("group_id", groupId)
      .maybeSingle();

    if (error) return dbErrorResponse(error);
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

    return Response.json({
      forum_id: forum.id,
      is_locked: forum.is_locked,
      is_coordinator: forumCoordinatorId(forum) === user.id,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

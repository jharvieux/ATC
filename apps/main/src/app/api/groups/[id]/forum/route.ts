// §19 — Resolve the forum for a group (1:1 via forums.group_id UNIQUE).
//
// GET /api/groups/:id/forum
// Returns { forum_id, is_locked, is_coordinator } so the client can route
// subsequent thread + message reads without a separate forum-lookup step.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

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
      .select("id, is_locked, coordinator_user_id")
      .eq("group_id", groupId)
      .maybeSingle();

    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

    return Response.json({
      forum_id: forum.id,
      is_locked: forum.is_locked,
      is_coordinator: forum.coordinator_user_id === user.id,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

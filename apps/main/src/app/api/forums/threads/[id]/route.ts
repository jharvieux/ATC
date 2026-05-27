// §19.7 — Coordinator thread management: lock, pin, mark-announcement, soft-delete.
//
// PATCH /api/forums/threads/:id
//   { action: 'lock' | 'unlock' | 'pin' | 'unpin' | 'announce' | 'unannounce' | 'delete' }

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { canModerate } from "@/lib/forums/permissions";
import { safeAwait } from "@/lib/db/safe-mutation";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "moderate_thread" });
    const svc = createServiceRoleClient();

    const { data: thread } = await svc
      .from("forum_threads")
      .select("*")
      .eq("id", params.id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (!thread) return Response.json({ error: "thread_not_found" }, { status: 404 });

    const { data: forum } = await svc.from("forums").select("*").eq("id", thread.forum_id).single();

    const userPerms = {
      id: user.id,
      role: "member",
      is_coordinator: forum?.coordinator_user_id === user.id,
    };

    if (!canModerate({ user: userPerms, forum: forum ?? { is_locked: false, coordinator_user_id: "" } })) {
      return Response.json({ error: "requires_coordinator" }, { status: 403 });
    }

    const { action } = await req.json() as { action: string };

    const updates: Record<string, unknown> = {};
    if (action === "lock") updates.is_locked = true;
    else if (action === "unlock") updates.is_locked = false;
    else if (action === "pin") updates.is_pinned = true;
    else if (action === "unpin") updates.is_pinned = false;
    else if (action === "announce") updates.is_announcement = true;
    else if (action === "unannounce") updates.is_announcement = false;
    else if (action === "delete") updates.deleted_at = new Date().toISOString();
    else return Response.json({ error: "unknown_action" }, { status: 400 });

    await safeAwait(svc.from("forum_threads").update(updates).eq("id", params.id), "forum_threads.update");
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[forum-threads PATCH]", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

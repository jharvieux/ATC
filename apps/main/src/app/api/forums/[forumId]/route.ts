// §19.7 — Forum-wide lock/unlock.
//
// PATCH /api/forums/:forumId  { action: 'lock' | 'unlock' }

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { canModerate } from "@/lib/forums/permissions";
import { safeAwait } from "@/lib/db/safe-mutation";

export async function PATCH(req: Request, props: { params: Promise<{ forumId: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "moderate_forum" });
    const svc = createServiceRoleClient();

    const { data: forum } = await svc
      .from("forums")
      .select("*")
      .eq("id", params.forumId)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

    const userPerms = {
      id: user.id,
      role: "member",
      is_coordinator: forum.coordinator_user_id === user.id,
    };

    if (!canModerate({ user: userPerms, forum })) {
      return Response.json({ error: "requires_coordinator" }, { status: 403 });
    }

    const { action } = await req.json() as { action: "lock" | "unlock" };
    // D-091 Pattern 5 — service-role bypasses RLS; tenant_id filter as
    // defense-in-depth (the upstream forum row was loaded by id only).
    await safeAwait(svc.from("forums").update({ is_locked: action === "lock" }).eq("id", params.forumId).eq("tenant_id", ctx.tenant_id), "forums.update");
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[forum PATCH]", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

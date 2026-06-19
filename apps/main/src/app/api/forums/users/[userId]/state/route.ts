// §19.7 — Coordinator mute/unmute of forum users.
//
// PATCH /api/forums/users/:userId/state
//   { forum_id, action: 'mute' | 'unmute', muted_until?: string }

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { canModerate, forumCoordinatorId } from "@/lib/forums/permissions";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";

export async function PATCH(req: Request, props: { params: Promise<{ userId: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "moderate_user" });
    const svc = createServiceRoleClient();

    const { forum_id, action, muted_until } = await req.json() as {
      forum_id: string;
      action: "mute" | "unmute";
      muted_until?: string;
    };

    const { data: forum } = await svc
      .from("forums")
      // #1190: coordinator lives on the linked group, not on forums.
      .select("*, groups(coordinator_user_id)")
      .eq("id", forum_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

    const userPerms = {
      id: user.id,
      role: "member",
      is_coordinator: forumCoordinatorId(forum) === user.id,
    };

    if (!canModerate({ user: userPerms, forum })) {
      return Response.json({ error: "requires_coordinator" }, { status: 403 });
    }

    if (action === "mute") {
      await safeAwait(svc.from("forum_user_state").upsert(
        {
          forum_id,
          user_id: params.userId,
          tenant_id: ctx.tenant_id,
          is_muted: true,
          muted_until: muted_until ?? null,
          muted_by_user_id: user.id,
          mute_reason: "coordinator_manual",
        },
        { onConflict: "forum_id,user_id" },
      ), "forum_user_state.upsert");
    } else if (action === "unmute") {
      await safeAwait(svc.from("forum_user_state").upsert(
        {
          forum_id,
          user_id: params.userId,
          tenant_id: ctx.tenant_id,
          is_muted: false,
          muted_until: null,
          muted_by_user_id: null,
          mute_reason: null,
        },
        { onConflict: "forum_id,user_id" },
      ), "forum_user_state.upsert");
    } else {
      return Response.json({ error: "unknown_action" }, { status: 400 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}

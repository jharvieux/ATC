// §19.7 — Coordinator mute/unmute of forum users.
//
// PATCH /api/forums/users/:userId/state
//   { forum_id, action: 'mute' | 'unmute', muted_until?: string }

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { canModerate } from "@/lib/forums/permissions";

export async function PATCH(
  req: Request,
  { params }: { params: { userId: string } },
): Promise<Response> {
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
      .select("*")
      .eq("id", forum_id)
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

    if (action === "mute") {
      await svc.from("forum_user_state").upsert(
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
      );
    } else if (action === "unmute") {
      await svc.from("forum_user_state").upsert(
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
      );
    } else {
      return Response.json({ error: "unknown_action" }, { status: 400 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    console.error("[forum-users-state PATCH]", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// §19.7 (coordinator hide/unhide/pin) and §19.8 (self-edit/delete).
//
// PATCH /api/forums/messages/:id
//   Coordinator: { action: 'hide' | 'unhide' | 'pin' }
//   Self:        { content: string }  (edit — appends to edit_history)
//   Self-delete: { action: 'delete' }

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { canModerate } from "@/lib/forums/permissions";
import { recordStrike, checkStrikePatterns } from "@/lib/forums/strikes";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "edit_message" });
    const svc = createServiceRoleClient();

    const { data: msg } = await svc
      .from("forum_messages")
      .select("*")
      .eq("id", params.id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (!msg) return Response.json({ error: "message_not_found" }, { status: 404 });

    const { data: forum } = await svc
      .from("forums")
      .select("*")
      .eq("id", msg.forum_id)
      .single();

    const userPerms = {
      id: user.id,
      role: "member",
      is_coordinator: forum?.coordinator_user_id === user.id,
    };

    const body = await req.json() as { action?: string; content?: string };
    const { action, content } = body;

    // Coordinator actions
    if (action === "hide" || action === "unhide" || action === "pin") {
      if (!canModerate({ user: userPerms, forum: forum ?? { is_locked: false, coordinator_user_id: "" } })) {
        return Response.json({ error: "requires_coordinator" }, { status: 403 });
      }

      if (action === "hide") {
        await svc.from("forum_messages").update({ status: "hidden" }).eq("id", params.id);
        await recordStrike(svc, {
          user_id: msg.user_id as string,
          forum_id: msg.forum_id as string,
          tenant_id: ctx.tenant_id,
          message_id: params.id,
          kind: "coordinator_hidden",
        });
        await checkStrikePatterns(svc, {
          user_id: msg.user_id as string,
          forum_id: msg.forum_id as string,
          tenant_id: ctx.tenant_id,
        });
      } else if (action === "unhide") {
        await svc.from("forum_messages").update({ status: "visible" }).eq("id", params.id);
      } else if (action === "pin") {
        // Pin is a thread-level concept; mark via thread route. No-op here.
        return Response.json({ error: "use_thread_route_to_pin" }, { status: 400 });
      }

      return Response.json({ ok: true });
    }

    // Self-delete (soft)
    if (action === "delete") {
      if ((msg.user_id as string) !== user.id) {
        return Response.json({ error: "cannot_delete_others_message" }, { status: 403 });
      }
      await svc.from("forum_messages").update({ deleted_at: new Date().toISOString() }).eq("id", params.id);
      return Response.json({ ok: true });
    }

    // Self-edit
    if (content !== undefined) {
      if ((msg.user_id as string) !== user.id) {
        return Response.json({ error: "cannot_edit_others_message" }, { status: 403 });
      }

      const editHistory = Array.isArray(msg.edit_history) ? msg.edit_history as unknown[] : [];
      editHistory.push({ content: msg.content, edited_at: msg.content_edited_at ?? msg.created_at });

      await svc.from("forum_messages").update({
        content,
        content_edited_at: new Date().toISOString(),
        edit_history: editHistory,
      }).eq("id", params.id);

      return Response.json({ ok: true });
    }

    return Response.json({ error: "no_action" }, { status: 400 });
  } catch (err) {
    console.error("[forum-messages PATCH]", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

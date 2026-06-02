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
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    // D-091 Round-2 Pattern 9 — one assertPermission per semantic operation.
    // Previously every branch went through a single edit_message check, which
    // was over-permissive for coordinator branches (hide/unhide/pin) and
    // misleading at audit time. Parse the body first, then dispatch with the
    // correct (resource, action) pair. Body parsing is cheap and the auth
    // failure case still produces a 401 before any DB read.
    const body = await req.json().catch(() => ({})) as { action?: string; content?: string };
    const { action, content } = body;

    const isCoordinatorAction = action === "hide" || action === "unhide" || action === "pin";
    const isSelfDelete = action === "delete";
    const isSelfEdit = content !== undefined && !action;

    let ctx: Awaited<ReturnType<typeof assertPermission>>["ctx"];
    let user: Awaited<ReturnType<typeof assertPermission>>["user"];
    if (isCoordinatorAction) {
      // Coordinator hide/unhide/pin — require moderate_thread (owner-only
      // grant). The is_coordinator instance check below still gates the
      // specific forum.
      ({ ctx, user } = await assertPermission(req, { resource: "forums", action: "moderate_thread" }));
    } else if (isSelfDelete || isSelfEdit) {
      ({ ctx, user } = await assertPermission(req, { resource: "forums", action: "edit_message" }));
    } else {
      // Unknown action — still require the baseline permission so probes can't
      // distinguish unauthenticated from invalid-body via response timing.
      ({ ctx, user } = await assertPermission(req, { resource: "forums", action: "edit_message" }));
      return Response.json({ error: "no_action" }, { status: 400 });
    }

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

    // Coordinator actions — instance check (this specific forum's coordinator).
    if (isCoordinatorAction) {
      if (!canModerate({ user: userPerms, forum: forum ?? { is_locked: false, coordinator_user_id: "" } })) {
        return Response.json({ error: "requires_coordinator" }, { status: 403 });
      }

      if (action === "hide") {
        // D-091 Pattern 5 — service-role bypasses RLS. Add tenant_id filter
        // as defense-in-depth: the upstream select already validated tenant,
        // but this update is now self-contained.
        await safeAwait(svc.from("forum_messages").update({ status: "hidden" }).eq("id", params.id).eq("tenant_id", ctx.tenant_id), "forum_messages.update");
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
        await safeAwait(svc.from("forum_messages").update({ status: "visible" }).eq("id", params.id).eq("tenant_id", ctx.tenant_id), "forum_messages.update");
      } else if (action === "pin") {
        // Pin is a thread-level concept; mark via thread route. No-op here.
        return Response.json({ error: "use_thread_route_to_pin" }, { status: 400 });
      }

      return Response.json({ ok: true });
    }

    // Self-delete (soft)
    if (isSelfDelete) {
      if ((msg.user_id as string) !== user.id) {
        return Response.json({ error: "cannot_delete_others_message" }, { status: 403 });
      }
      await safeAwait(svc.from("forum_messages").update({ deleted_at: new Date().toISOString() }).eq("id", params.id).eq("tenant_id", ctx.tenant_id), "forum_messages.update");
      return Response.json({ ok: true });
    }

    // Self-edit
    if (content !== undefined) {
      if ((msg.user_id as string) !== user.id) {
        return Response.json({ error: "cannot_edit_others_message" }, { status: 403 });
      }

      const editHistory = Array.isArray(msg.edit_history) ? msg.edit_history as unknown[] : [];
      editHistory.push({ content: msg.content, edited_at: msg.content_edited_at ?? msg.created_at });

      await safeAwait(svc.from("forum_messages").update({
        content,
        content_edited_at: new Date().toISOString(),
        edit_history: editHistory,
      }).eq("id", params.id).eq("tenant_id", ctx.tenant_id), "forum_messages.update");

      return Response.json({ ok: true });
    }

    return Response.json({ error: "no_action" }, { status: 400 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

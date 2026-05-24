// §18.5 — Coordinator revocation surface.
//
// GET  /api/groups/[id]/invitations             — list all invitations for coordinator
// POST /api/groups/[id]/invitations/revoke      — revoke individual token
// POST /api/groups/[id]/invitations/reissue-all — bulk re-issue (revoke old + new rows)

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { generateToken } from "@/lib/groups/invitation-token";

type RouteProps = { params: { id: string } };

export async function GET(req: Request, { params }: RouteProps): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "group.invitations", action: "list" });

    const svc = createServiceRoleClient();

    // Confirm requester is coordinator or admin.
    const { data: group, error: gErr } = await svc
      .from("groups")
      .select("id,coordinator_user_id,tenant_id")
      .eq("id", params.id)
      .eq("tenant_id", ctx.tenant_id)
      .single();

    if (gErr || !group) return Response.json({ error: "Group not found" }, { status: 404 });
    if (group.coordinator_user_id !== user.id) {
      return Response.json({ error: "Only the group coordinator can manage invitations" }, { status: 403 });
    }

    const { data: invitations, error: invErr } = await svc
      .from("invitations")
      .select("id,invitee_email,invitee_name,rsvp_state,token_revoked_at,token_revoked_reason,token_first_used_at,last_email_sent_at")
      .eq("group_id", params.id)
      .order("created_at", { ascending: true });

    if (invErr) return Response.json({ error: invErr.message }, { status: 500 });
    return Response.json({ invitations });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
}

export async function POST(req: Request, { params }: RouteProps): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "group.invitations", action: "manage" });
    const body = await req.json() as { action: string; invitation_id?: string };

    const svc = createServiceRoleClient();

    // Confirm requester is coordinator.
    const { data: group, error: gErr } = await svc
      .from("groups")
      .select("id,coordinator_user_id,tenant_id")
      .eq("id", params.id)
      .eq("tenant_id", ctx.tenant_id)
      .single();

    if (gErr || !group) return Response.json({ error: "Group not found" }, { status: 404 });
    if (group.coordinator_user_id !== user.id) {
      return Response.json({ error: "Only the group coordinator can manage invitations" }, { status: 403 });
    }

    const now = new Date().toISOString();

    if (body.action === "revoke" && body.invitation_id) {
      const { error } = await svc
        .from("invitations")
        .update({ token_revoked_at: now, token_revoked_reason: "invitee_removed" })
        .eq("id", body.invitation_id)
        .eq("group_id", params.id)
        .is("token_revoked_at", null);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ ok: true, action: "revoked" });
    }

    if (body.action === "revoke_suspected_compromise" && body.invitation_id) {
      const { error } = await svc
        .from("invitations")
        .update({ token_revoked_at: now, token_revoked_reason: "suspected_compromise" })
        .eq("id", body.invitation_id)
        .eq("group_id", params.id);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ ok: true, action: "revoked_suspected_compromise" });
    }

    if (body.action === "reissue_all") {
      // §18.5 bulk re-issue: revoke all outstanding tokens, insert fresh invitation rows.
      // Choice documented in MEMORY: new rows with new tokens (not rotate on existing).
      const { data: active, error: fetchErr } = await svc
        .from("invitations")
        .select("id,invitee_email,invitee_name,personal_note,visibility_choice")
        .eq("group_id", params.id)
        .is("token_revoked_at", null);

      if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });

      // Revoke existing.
      await svc
        .from("invitations")
        .update({ token_revoked_at: now, token_revoked_reason: "coordinator_revoked" })
        .eq("group_id", params.id)
        .is("token_revoked_at", null);

      // Insert fresh rows with new tokens.
      if (active && active.length > 0) {
        const newRows = active.map((inv) => {
          const newId = crypto.randomUUID();
          return {
            id: newId,
            group_id: params.id,
            invitee_email: inv.invitee_email,
            invitee_name: inv.invitee_name,
            personal_note: inv.personal_note,
            visibility_choice: inv.visibility_choice,
            token: generateToken(newId),
          };
        });
        const { error: insertErr } = await svc.from("invitations").insert(newRows);
        if (insertErr) return Response.json({ error: insertErr.message }, { status: 500 });
      }

      return Response.json({ ok: true, action: "reissued", count: active?.length ?? 0 });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
}

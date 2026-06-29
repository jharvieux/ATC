// §18.5 — Coordinator revocation surface.
//
// GET  /api/groups/[id]/invitations             — list all invitations for coordinator
// POST /api/groups/[id]/invitations             — actions: invite | revoke | revoke_suspected_compromise | reissue_all

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { generateToken } from "@/lib/groups/invitation-token";
import { safeAwait } from "@/lib/db/safe-mutation";
import { sendGroupInvitationEmail, type GroupInvitationGroup } from "@/lib/groups/send-invitation-email";
import { assertGroupNotSailed, GroupSailedError } from "@/lib/groups/sailed-gate";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

type RouteProps = { params: Promise<{ id: string }> };

export async function GET(req: Request, props: RouteProps): Promise<Response> {
  const params = await props.params;
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

    if (invErr) return dbErrorResponse(invErr);
    return Response.json({ invitations });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request, props: RouteProps): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "group.invitations", action: "manage" });
    const body = await req.json() as {
      action: string;
      invitation_id?: string;
      invitee_email?: string;
      invitee_name?: string;
      personal_note?: string;
      visibility_choice?: string;
    };

    const svc = createServiceRoleClient();

    // Confirm requester is coordinator.
    const { data: group, error: gErr } = await svc
      .from("groups")
      .select("id,coordinator_user_id,tenant_id,cruise_line,ship_name,sailing_date,departure_port,coordinator_message,hero_image_url")
      .eq("id", params.id)
      .eq("tenant_id", ctx.tenant_id)
      .single();

    if (gErr || !group) return Response.json({ error: "Group not found" }, { status: 404 });
    if (group.coordinator_user_id !== user.id) {
      return Response.json({ error: "Only the group coordinator can manage invitations" }, { status: 403 });
    }

    // §18.10 — Group invitations management (revoke / reissue / invite) is part of
    // "member management" which is blocked once the group has sailed.
    try {
      await assertGroupNotSailed(svc, params.id, ctx.tenant_id);
    } catch (e) {
      if (e instanceof GroupSailedError) {
        return Response.json(
          { error: "group_sailed", sailed_at: e.sailed_at, message: "This trip has sailed. Invitation management is no longer available." },
          { status: 410 },
        );
      }
      return Response.json({ error: "group_sailed_lookup_failed" }, { status: 500 });
    }

    const now = new Date().toISOString();

    if (body.action === "invite" && body.invitee_email) {
      const email = (body.invitee_email as string).trim().toLowerCase();
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return Response.json({ error: "Invalid invitee_email" }, { status: 400 });
      }
      const vis = (body.visibility_choice as string | undefined) ?? "no_opinion";
      const VALID_VIS = new Set(["no_opinion", "be_anonymous", "show_me_anyway"]);
      if (!VALID_VIS.has(vis)) {
        return Response.json({ error: "Invalid visibility_choice" }, { status: 400 });
      }

      const invId = crypto.randomUUID();
      const insertedRows = await safeAwait(
        svc.from("invitations").insert({
          id: invId,
          group_id: params.id,
          invitee_email: email,
          invitee_name: (body.invitee_name as string | undefined) ?? null,
          personal_note: (body.personal_note as string | undefined) ?? null,
          visibility_choice: vis,
          // invitations.token is NOT NULL UNIQUE — omitting it 500'd every
          // single-invitee add (the create + reissue_all paths set it too).
          token: generateToken(invId),
        }).select("id"),
        "invitations.insert",
      );
      if (!insertedRows || (insertedRows as Array<unknown>).length === 0) {
        return Response.json({ error: "Failed to create invitation" }, { status: 500 });
      }

      // fail-silent — sendGroupInvitationEmail never throws; errors are logged inside.
      await sendGroupInvitationEmail({
        svc,
        invitationId: invId,
        group: group as unknown as GroupInvitationGroup,
        tenantId: group.tenant_id,
      });

      return Response.json({ ok: true, invitation_id: invId });
    }

    if (body.action === "revoke" && body.invitation_id) {
      const { error } = await svc
        .from("invitations")
        .update({ token_revoked_at: now, token_revoked_reason: "invitee_removed" })
        .eq("id", body.invitation_id)
        .eq("group_id", params.id)
        .is("token_revoked_at", null);
      if (error) return dbErrorResponse(error);
      return Response.json({ ok: true, action: "revoked" });
    }

    if (body.action === "revoke_suspected_compromise" && body.invitation_id) {
      const { error } = await svc
        .from("invitations")
        .update({ token_revoked_at: now, token_revoked_reason: "suspected_compromise" })
        .eq("id", body.invitation_id)
        .eq("group_id", params.id);
      if (error) return dbErrorResponse(error);
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

      if (fetchErr) return dbErrorResponse(fetchErr);

      // Revoke existing.
      await safeAwait(svc
        .from("invitations")
        .update({ token_revoked_at: now, token_revoked_reason: "coordinator_revoked" })
        .eq("group_id", params.id)
        .is("token_revoked_at", null), "invitations.update");

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
        if (insertErr) return dbErrorResponse(insertErr);
      }

      return Response.json({ ok: true, action: "reissued", count: active?.length ?? 0 });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

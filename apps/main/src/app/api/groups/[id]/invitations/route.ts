// §18.5 — Coordinator revocation surface.
//
// GET  /api/groups/[id]/invitations             — list all invitations for coordinator
// POST /api/groups/[id]/invitations             — actions: invite | revoke | revoke_suspected_compromise | reissue_all

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { generateToken } from "@/lib/groups/invitation-token";
import { safeAwait } from "@/lib/db/safe-mutation";
import { assertGroupNotSailed, GroupSailedError } from "@/lib/groups/sailed-gate";
import { respondToAuthError } from "@/lib/auth/respond";

type RouteProps = { params: Promise<{ id: string }> };

// Narrow type for groups used by the email helper below.
type GroupRow = {
  id: string;
  tenant_id: string;
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  departure_port: string;
  coordinator_message: string | null;
  hero_image_url: string | null;
};

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

    if (invErr) return Response.json({ error: invErr.message }, { status: 500 });
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
      await assertGroupNotSailed(svc, params.id);
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
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
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
        }).select("id"),
        "invitations.insert",
      );
      if (!insertedRows || (insertedRows as Array<unknown>).length === 0) {
        return Response.json({ error: "Failed to create invitation" }, { status: 500 });
      }

      // Send invitation email (fail-silent: the invitation row is already committed;
      // email failure is recoverable and must not roll back the insert).
      try {
        await sendGroupInvitationEmail({
          svc,
          invitationId: invId,
          group: group as unknown as GroupRow,
          tenantId: group.tenant_id,
        });
      } catch (err) {
        console.error(
          `[group-invitation] email send failed for inv=${invId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return Response.json({ ok: true, invitation_id: invId });
    }

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
        if (insertErr) return Response.json({ error: insertErr.message }, { status: 500 });
      }

      return Response.json({ ok: true, action: "reissued", count: active?.length ?? 0 });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

async function sendGroupInvitationEmail(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  invitationId: string;
  group: GroupRow;
  tenantId: string;
}): Promise<void> {
  const [
    { data: inv },
    { data: tenant },
    { data: branding },
    { data: allInvitations },
  ] = await Promise.all([
    // d091-allow:service-role-tenant — invitations has no tenant_id column; scoped by invitation UUID just inserted above.
    args.svc.from("invitations").select("id,invitee_email,invitee_name").eq("id", args.invitationId).single(),
    args.svc.from("tenants").select("id,legal_name,mailing_address").eq("id", args.tenantId).single(),
    args.svc.from("tenant_branding").select("logo_url,primary_color,secondary_color,accent_color,slogan").eq("tenant_id", args.tenantId).maybeSingle(),
    // d091-allow:service-role-tenant — invitations has no tenant_id column; scoped by group_id which was verified .eq("tenant_id", ctx.tenant_id) above.
    args.svc.from("invitations").select("rsvp_state").eq("group_id", args.group.id).is("token_revoked_at", null),
  ]);

  if (!inv || !tenant) return;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";
  const { generateToken: genToken } = await import("@/lib/groups/invitation-token");
  const inviteUrl = `${baseUrl}/group/invite/${genToken(args.invitationId)}`;

  const { signUnsubscribeToken } = await import("@/lib/email/unsubscribe-token");
  const unsubToken = signUnsubscribeToken({ email: inv.invitee_email, tenant_id: args.tenantId, category: "group_invitation" });

  const layoutProps = {
    branding: {
      logo_url: branding?.logo_url ?? null,
      primary_color: branding?.primary_color ?? null,
      secondary_color: branding?.secondary_color ?? null,
      accent_color: branding?.accent_color ?? null,
      slogan: branding?.slogan ?? null,
    },
    tenant_legal_name: tenant.legal_name ?? "Travel Agency",
    tenant_business_address: tenant.mailing_address ?? "",
    unsubscribe_url: `${baseUrl}/email/unsubscribe?token=${unsubToken}`,
  };

  const invList = (allInvitations ?? []) as { rsvp_state: string }[];
  const bookedCount = invList.filter((i) => i.rsvp_state === "booked").length;
  const interestedCount = invList.filter((i) => i.rsvp_state === "interested").length;

  const { resolveEmailContent, renderOverrideBodyInLayout } = await import("@/lib/email/template-resolve");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { GroupInvitation } = await import("@/emails/GroupInvitation");

  const resolved = await resolveEmailContent({
    db: args.svc,
    tenant_id: args.tenantId,
    email_type: "group_invitation",
    variables: {
      invitee_name: inv.invitee_name ?? "there",
      cruise_line: args.group.cruise_line,
      ship_name: args.group.ship_name,
      sailing_date: args.group.sailing_date,
      departure_port: args.group.departure_port,
      coordinator_message: args.group.coordinator_message ?? "",
      invite_url: inviteUrl,
    },
  });

  const html = resolved.overrideBodyText !== null
    ? await renderOverrideBodyInLayout(layoutProps, resolved.overrideBodyText)
    : renderToStaticMarkup(React.createElement(GroupInvitation, {
        ...layoutProps,
        invitee_name: inv.invitee_name ?? null,
        cruise_line: args.group.cruise_line,
        ship_name: args.group.ship_name,
        sailing_date: args.group.sailing_date,
        departure_port: args.group.departure_port,
        coordinator_message: args.group.coordinator_message ?? null,
        hero_image_url: args.group.hero_image_url ?? null,
        booked_count: bookedCount,
        interested_count: interestedCount,
        invite_url: inviteUrl,
      }));

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "trips@ai-travelconcierge.com",
      to: inv.invitee_email,
      subject: resolved.subject,
      html,
    }),
  });
}

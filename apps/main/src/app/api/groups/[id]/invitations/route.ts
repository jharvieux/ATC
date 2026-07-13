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
import { loadTenantSnapshot } from "@/lib/abuse/snapshot";
import { incrementGroupInvitees } from "@/lib/abuse/counters";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { MAX_INVITEES_PER_GROUP } from "@/lib/groups/constants";
import { checkInviteFrequency } from "@/lib/groups/invite-rate-limit";

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

      // #1654 — per-endpoint frequency gate. group_invitation sends bypass the
      // general per-send email throttle by design (email/rate-limit.ts), so
      // without this a coordinator could rapid-fire unique-address invites (a
      // revoke→reinvite spam vector). DB-backed shared store, fail-closed: a
      // count-query error denies (D-091 #19).
      const freq = await checkInviteFrequency(svc, params.id);
      if (!freq.allowed) {
        return Response.json(
          { error: "invite_rate_limited", retry_after_seconds: freq.retryAfterSeconds },
          { status: 429 },
        );
      }

      // #1600 — the create path caps at 50 active invitees per group
      // (groups/route.ts); the single-invite path enforces the same cap via the
      // shared MAX_INVITEES_PER_GROUP constant.
      // #1680: this count-then-insert is NOT atomic — two concurrent invites to
      // the same group can both read count=49 and both insert, overshooting the
      // cap. Accepted as low-severity: the actor is an authenticated
      // coordinator, the race requires two invites to the SAME group within one
      // request window, and the blast radius is a handful of invitees over 50.
      // A true atomic fix needs a DB migration (an advisory-lock RPC that
      // count-checks + inserts in one transaction, or a partial exclusion
      // constraint) — not expressible through PostgREST's autocommit-per-call.
      // The migration is not yet approved, so the race stays accepted here and
      // the atomic reserve remains tracked on #1680.
      const { count: activeCount, error: countErr } = await svc
        // d091-allow:service-role-tenant — invitations has no tenant_id column; group_id is already verified against ctx.tenant_id above.
        .from("invitations")
        .select("id", { count: "exact", head: true })
        .eq("group_id", params.id)
        .is("token_revoked_at", null);
      if (countErr) return dbErrorResponse(countErr);
      if ((activeCount ?? 0) >= MAX_INVITEES_PER_GROUP) {
        return Response.json({ error: `Maximum ${MAX_INVITEES_PER_GROUP} invitees per group` }, { status: 400 });
      }

      const invId = crypto.randomUUID();
      const token = await generateToken(invId);
      const { data: insertedRows, error: insertErr } = await svc
        // d091-allow:service-role-tenant — invitations has no tenant_id column; group_id is already verified against ctx.tenant_id above.
        .from("invitations")
        .insert({
          id: invId,
          group_id: params.id,
          invitee_email: email,
          invitee_name: (body.invitee_name as string | undefined) ?? null,
          personal_note: (body.personal_note as string | undefined) ?? null,
          visibility_choice: vis,
          // invitations.token is NOT NULL UNIQUE — omitting it 500'd every
          // single-invitee add (the create + reissue_all paths set it too).
          token,
        })
        .select("id");

      if (insertErr) {
        // #1600 — invitations_group_active_email_uniq_idx (partial, active rows
        // only) rejects a repeat invite to an already-invited address.
        if (insertErr.code === "23505") {
          return Response.json({ error: "invitee_already_invited" }, { status: 409 });
        }
        return dbErrorResponse(insertErr);
      }
      if (!insertedRows || insertedRows.length === 0) {
        return Response.json({ error: "Failed to create invitation" }, { status: 500 });
      }

      // BP27 §27.4 — bump the group-invitees counter, matching the create
      // path (groups/route.ts). Non-fatal: the invitation row already exists.
      try {
        const snapshot = await loadTenantSnapshot(svc, ctx.tenant_id);
        await incrementGroupInvitees({ db: svc, tenant: snapshot.tenant }, 1);
      } catch (err) {
        console.warn(`[groups] counter increment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
        const newRows = await Promise.all(
          active.map(async (inv) => {
            const newId = crypto.randomUUID();
            return {
              id: newId,
              group_id: params.id,
              invitee_email: inv.invitee_email,
              invitee_name: inv.invitee_name,
              personal_note: inv.personal_note,
              visibility_choice: inv.visibility_choice,
              token: await generateToken(newId),
            };
          }),
        );
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

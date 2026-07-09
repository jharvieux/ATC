// Shared group-invitation email sender. Used by both the single-invitee "invite"
// action (api/groups/[id]/invitations) and the immediate send on group creation
// (api/groups). Fail-silent: it never throws — sendEmail returns a status and a
// failed send is logged, not surfaced, so a delivery problem can't break the
// coordinator's create/invite request.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/send";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import { safeAwait } from "@/lib/db/safe-mutation";

// Narrow shape of the group fields the invitation email needs.
export type GroupInvitationGroup = {
  id: string;
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  departure_port: string;
  coordinator_message: string | null;
  hero_image_url: string | null;
};

export async function sendGroupInvitationEmail(args: {
  svc: SupabaseClient;
  invitationId: string;
  group: GroupInvitationGroup;
  tenantId: string;
}): Promise<void> {
  // Hoisted so the fail-silent catch (#1707) can name the invitee in the
  // email_log row, and so the claim (#1716) can be reverted from either the
  // failed-send branch or the catch.
  let inviteeEmail: string | null = null;
  let claimed = false;

  // #1707 — best-effort email_log "rejected" row so a send that never dispatched
  // (or a stamp that got stuck) is queryable per-tenant, not just a console line.
  // Fully fail-silent: its own error is swallowed, never rethrown into the caller.
  const writeRejectedEmailLog = async (subject: string, bounceReason: string): Promise<void> => {
    try {
      const { error: logErr } = await args.svc.from("email_log").insert({
        tenant_id: args.tenantId,
        to_email: inviteeEmail ?? `unknown:invitation:${args.invitationId}`,
        from_email: "(unresolved-pre-send-failure)",
        subject,
        template_id: "group_invitation",
        email_category: "group_invitation",
        status: "rejected",
        related_group_id: args.group.id,
        bounce_reason: bounceReason,
      });
      if (logErr) {
        console.error(`[group-invitation] email_log write failed for inv=${args.invitationId}: ${logErr.message}`);
      }
    } catch (logThrow) {
      console.error(`[group-invitation] email_log write threw for inv=${args.invitationId}: ${logThrow instanceof Error ? logThrow.message : String(logThrow)}`);
    }
  };

  // #1716 — revert the pre-send stamp (claim) so a send that didn't go out
  // doesn't suppress the cadence's next reminder. Raw destructure (not
  // safeAwait) so it can never throw back into the caller's request.
  const revertClaim = async (): Promise<void> => {
    const { error } = await args.svc
      // d091-allow:service-role-tenant — invitations has no tenant_id column; scoped by invitation UUID just inserted by the caller.
      .from("invitations")
      .update({ last_email_sent_at: null })
      .eq("id", args.invitationId);
    if (error) {
      // Revert failed — the stamp is stuck non-null and will suppress this
      // invitee's next cadence reminder. Clear the in-memory flag ONLY on
      // success, and surface the stuck stamp the same way #1707 surfaces a
      // pre-send failure: a queryable email_log row operators can see.
      console.warn(`[group-invitation] claim revert failed for inv=${args.invitationId}: ${error.message}`);
      await writeRejectedEmailLog(
        "Group invitation (claim revert failed — stamp stuck)",
        `claim revert failed: ${error.message}`,
      );
      return;
    }
    claimed = false;
  };

  try {
    const [
    { data: inv },
    { data: tenant },
    { data: branding },
    { data: allInvitations },
  ] = await Promise.all([
    // d091-allow:service-role-tenant — invitations has no tenant_id column; scoped by invitation UUID just inserted by the caller.
    args.svc.from("invitations").select("id,invitee_email,invitee_name").eq("id", args.invitationId).single(),
    // #1190: email_* / send-pattern / resend-key live on tenant_branding, not
    // tenants — read them from the branding row below.
    args.svc.from("tenants").select("id,legal_name,mailing_address").eq("id", args.tenantId).single(),
    args.svc.from("tenant_branding").select("logo_url,primary_color,secondary_color,accent_color,slogan,email_send_pattern,tenant_resend_api_key_encrypted,email_from_address,email_from_name,email_from_domain,email_from_domain_verified_at").eq("tenant_id", args.tenantId).maybeSingle(),
    // d091-allow:service-role-tenant — invitations has no tenant_id column; scoped by group_id, which the caller verified belongs to ctx.tenant_id.
    args.svc.from("invitations").select("rsvp_state").eq("group_id", args.group.id).is("token_revoked_at", null),
  ]);

  if (!inv || !tenant) return;
  inviteeEmail = inv.invitee_email;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";
  const { generateToken: genToken } = await import("@/lib/groups/invitation-token");
  const inviteUrl = `${baseUrl}/group/invite/${await genToken(args.invitationId)}`;

  const { signUnsubscribeToken } = await import("@/lib/email/unsubscribe-token");
  const unsubToken = await signUnsubscribeToken({ email: inv.invitee_email, tenant_id: args.tenantId, category: "group_invitation" });

  const layoutProps = {
    branding: {
      logo_url: branding?.logo_url ?? null,
      primary_color: branding?.primary_color ?? null,
      secondary_color: branding?.secondary_color ?? null,
      accent_color: branding?.accent_color ?? null,
      slogan: branding?.slogan ?? null,
    },
    tenant_legal_name: tenant.legal_name ?? "Travel Agency",
    tenant_business_address: formatMailingAddress(tenant.mailing_address),
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

  // #1716 — claim-before-send (D-091 #21). Stamp last_email_sent_at BEFORE the
  // send. Previously the stamp landed only AFTER sendEmail returned "sent", so a
  // crash in that gap left the stamp NULL and the next 08:00 UTC cadence run
  // sent one duplicate (group-reminder-cadence.ts reads a NULL stamp as "never
  // emailed" and skips its interval guard). Stamping first closes that window;
  // revertClaim() below clears it if the send doesn't actually go out, so a
  // suppressed/rate-limited/failed send (or a pre-send throw) still lets the
  // cadence retry — a send that never happened must not suppress a legitimate
  // reminder. Reverting to NULL is safe: this helper only runs on freshly
  // created invitation rows, where the stamp starts NULL.
  //
  // CAS guard (D-091 #21): the stamp only lands where last_email_sent_at IS
  // NULL. If a concurrent send or a cadence run already claimed this row, the
  // update matches zero rows — treat that as claim-lost and skip the send so we
  // never duplicate the winner's email.
  const claimRows = await safeAwait(
    // d091-allow:service-role-tenant — invitations has no tenant_id column; scoped by invitation UUID just inserted by the caller.
    args.svc.from("invitations").update({ last_email_sent_at: new Date().toISOString() }).is("last_email_sent_at", null).select("id"),
    "invitations.update.last_email_sent_at.claim",
  );
  if (!claimRows || (claimRows as unknown[]).length === 0) {
    console.warn(`[group-invitation] claim lost for inv=${args.invitationId}; another send already stamped it — skipping`);
    return;
  }
  claimed = true;

  // Route through the shared send helper so suppression, rate-limiting,
  // tenant from-address resolution (§16.4), and the email_log write all
  // apply consistently. HTML is rendered above; sendEmail expects it pre-built.
  const result = await sendEmail({
    db: args.svc,
    tenant: {
      id: tenant.id,
      legal_name: tenant.legal_name ?? "Travel Agency",
      mailing_address: formatMailingAddress(tenant.mailing_address),
      // #1190: email send config comes from tenant_branding.
      email_send_pattern: branding?.email_send_pattern ?? "platform_resend",
      tenant_resend_api_key_encrypted: branding?.tenant_resend_api_key_encrypted ?? null,
      email_from_address: branding?.email_from_address ?? null,
      email_from_name: branding?.email_from_name ?? null,
      email_from_domain: branding?.email_from_domain ?? null,
      email_from_domain_verified_at: branding?.email_from_domain_verified_at ?? null,
    },
    to: inv.invitee_email,
    subject: resolved.subject,
    template_id: "group_invitation",
    category: "group_invitation",
    html,
    related_group_id: args.group.id,
    idempotencyKey: `group_invitation:${args.invitationId}`,
  });

  if (result.status === "sent") {
    // Send delivered — the DB stamp stays (it counts as the first reminder for
    // cadence purposes, #1584). Clearing the in-memory flag only stops the catch
    // block below from reverting a stamp that legitimately stands.
    claimed = false;
  } else if (result.status === "failed") {
    // Something broke (key missing/malformed, Resend 5xx) — actionable.
    await revertClaim();
    console.error(
      `[group-invitation] send failed for inv=${args.invitationId}: ${result.reason ?? "unknown"}`,
    );
  } else {
    // suppressed / rate_limited — expected, not an error.
    await revertClaim();
    console.warn(
      `[group-invitation] send not delivered for inv=${args.invitationId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
    );
  }
  } catch (err) {
    console.error(
      `[group-invitation] send failed for inv=${args.invitationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // #1716 — if we already claimed (crash/throw between the stamp and a
    // delivered send), clear it so the cadence retries this invitee.
    if (claimed) await revertClaim();
    // #1707 — a failure BEFORE sendEmail (the invitations/tenants/branding
    // reads, template resolution, token generation, React rendering) used to
    // leave only this console.error — no per-tenant queryable record that the
    // invite never went out (operators don't watch app logs per tenant). Write
    // a best-effort email_log row (status 'rejected', the same terminal status
    // sendEmail writes on a vendor failure) so the failure is observable.
    await writeRejectedEmailLog(
      "Group invitation (send failed before dispatch)",
      err instanceof Error ? err.message : String(err),
    );
  }
}

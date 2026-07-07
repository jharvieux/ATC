// Shared group-invitation email sender. Used by both the single-invitee "invite"
// action (api/groups/[id]/invitations) and the immediate send on group creation
// (api/groups). Fail-silent: it never throws — sendEmail returns a status and a
// failed send is logged, not surfaced, so a delivery problem can't break the
// coordinator's create/invite request.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/send";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";

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

  if (result.status === "failed") {
    // Something broke (key missing/malformed, Resend 5xx) — actionable.
    console.error(
      `[group-invitation] send failed for inv=${args.invitationId}: ${result.reason ?? "unknown"}`,
    );
  } else if (result.status !== "sent") {
    // suppressed / rate_limited — expected, not an error.
    console.warn(
      `[group-invitation] send not delivered for inv=${args.invitationId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
    );
  }
  } catch (err) {
    console.error(
      `[group-invitation] send failed for inv=${args.invitationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

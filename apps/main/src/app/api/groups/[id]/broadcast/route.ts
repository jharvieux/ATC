// §7.7 / §18.6 — Coordinator broadcast to selected RSVP states.
//
// The coordinator chooses which RSVP states receive each broadcast
// (recipient_states); omitted defaults to the engaged+committed set
// (interested + booked). (#1056: the prior code filtered on a non-existent
// `status = 'accepted'` column — invitations has no `status` column and no
// 'accepted' value; RSVP state is `rsvp_state` ∈ pending|interested|
// not_going|booked, so the old query hard-500'd and broadcast never sent.)
//
// Renders GroupBroadcast (BrandedLayout-wrapped) per-recipient and dispatches
// via sendTenantNotification, which handles suppressions + rate limits +
// email_log. Sailed groups are blocked (§18.10).

import { z } from "zod";
import * as React from "react";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { assertGroupNotSailed, GroupSailedError } from "@/lib/groups/sailed-gate";
import { sendTenantNotification } from "@/lib/email/notifications";
import { GroupBroadcast } from "@/emails/GroupBroadcast";

// invitations.rsvp_state CHECK values (apps/main/supabase/migrations/
// 20260529000000_groups.sql). Keep in sync with that constraint.
const RSVP_STATES = ["pending", "interested", "not_going", "booked"] as const;

// §18.6 default audience when the coordinator doesn't specify: people who've
// shown intent (interested) or committed (booked). Excludes pending
// non-responders and not_going declines.
const DEFAULT_RECIPIENT_STATES: readonly string[] = ["interested", "booked"];

const BodySchema = z
  .object({
    subject: z.string().min(1).max(200),
    message: z.string().min(1).max(20000),
    // #1056 — coordinator-selected recipient RSVP states. Omitted → default
    // audience. An explicit empty array is rejected (.min(1)): a broadcast to
    // nobody is a UI error, not a silent no-op.
    recipient_states: z
      .array(z.enum(RSVP_STATES))
      .min(1)
      .max(RSVP_STATES.length)
      .optional(),
  })
  .strict();

interface GroupRow {
  id: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
}

interface MemberRow {
  invitee_email: string | null;
}

interface TenantRow {
  legal_name: string | null;
  mailing_address: string | null;
}

interface BrandingRow {
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  slogan: string | null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "groups",
      action: "broadcast",
    });

    const body: unknown = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const { subject, message } = parsed.data;
    const recipientStates = parsed.data.recipient_states ?? DEFAULT_RECIPIENT_STATES;

    const { id } = await params;
    const db = tenantClient(ctx);

    const { data: groupRow, error: groupErr } = await db
      .from("groups")
      .select("id, cruise_line, ship_name, sailing_date")
      .eq("id", id)
      .maybeSingle();
    if (groupErr) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }
    if (!groupRow) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const group = groupRow as unknown as GroupRow;

    try {
      await assertGroupNotSailed(db, id, ctx.tenant_id);
    } catch (err) {
      if (err instanceof GroupSailedError) {
        return Response.json(
          { error: "group_sailed", sailed_at: err.sailed_at },
          { status: 410 },
        );
      }
      throw err;
    }

    // Recipients = invitations in the selected RSVP states (§18.6). invitations
    // has no tenant_id (PLATFORM_READABLE, #1054); isolation holds via group_id,
    // whose tenant ownership was verified by the tenant-scoped groups query above.
    const { data: memberRows, error: memberErr } = await db
      .from("invitations")
      .select("invitee_email")
      .eq("group_id", id)
      .in("rsvp_state", recipientStates);
    if (memberErr) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }
    const recipients = ((memberRows ?? []) as MemberRow[])
      .map((m) => m.invitee_email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);

    if (recipients.length === 0) {
      return Response.json({ sent: 0, suppressed: 0, failed: 0, reason: "no_recipients" });
    }

    // Tenant + branding for BrandedLayout render. sendTenantNotification
    // loads its own copy for from-address resolution; we pre-load here for
    // the body render so the visual matches the in-app preview. Fail loud
    // on either error — sending with default-string identity would mislead
    // recipients about who they're hearing from.
    const { data: tenantRow, error: tenantErr } = await db
      .from("tenants")
      .select("legal_name, mailing_address")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    if (tenantErr) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }
    const { data: brandingRow, error: brandingErr } = await db
      .from("tenant_branding")
      .select("logo_url, primary_color, secondary_color, accent_color, slogan")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (brandingErr) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }
    const tenant = (tenantRow ?? null) as TenantRow | null;
    const branding = (brandingRow ?? null) as BrandingRow | null;

    const tenant_legal_name = tenant?.legal_name ?? "Your travel coordinator";
    const tenant_business_address = tenant?.mailing_address ?? "";
    const groupName = [group.cruise_line, group.ship_name].filter(Boolean).join(" — ") ||
      "Your cruise";

    // Token-style unsubscribe is a separate effort — for now use an
    // absolute URL to the recipient's settings page. Convention with
    // every other outbound email in this codebase: absolute href so
    // email-client base resolution doesn't break the link.
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const unsubscribeUrl = `${baseUrl}/settings/notifications`;
    const { renderToStaticMarkup } = await import("react-dom/server");

    let sent = 0;
    let suppressed = 0;
    let failed = 0;
    for (const to of recipients) {
      const html = renderToStaticMarkup(
        React.createElement(GroupBroadcast, {
          branding: branding ?? {},
          tenant_legal_name,
          tenant_business_address,
          unsubscribe_url: unsubscribeUrl,
          subject,
          message,
          group_name: groupName,
        }),
      );
      const result = await sendTenantNotification({
        db,
        tenant_id: ctx.tenant_id,
        to,
        subject,
        template_id: "group_broadcast",
        category: "transactional",
        html,
      });
      if (result.status === "sent") sent++;
      else if (result.status === "suppressed" || result.status === "rate_limited") suppressed++;
      else failed++;
    }

    return Response.json({ sent, suppressed, failed });
  } catch (err) {
    return respondToAuthError(err);
  }
}

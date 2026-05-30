// §7.7 / §18.6 — Coordinator broadcast to all accepted group members.
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

const BodySchema = z
  .object({
    subject: z.string().min(1).max(200),
    message: z.string().min(1).max(20000),
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

    const { id } = await params;
    const db = tenantClient(ctx);

    const { data: groupRow, error: groupErr } = await db
      .from("groups")
      .select("id, cruise_line, ship_name, sailing_date")
      .eq("id", id)
      .maybeSingle();
    if (groupErr) {
      return Response.json({ error: groupErr.message }, { status: 500 });
    }
    if (!groupRow) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const group = groupRow as unknown as GroupRow;

    try {
      await assertGroupNotSailed(db, id);
    } catch (err) {
      if (err instanceof GroupSailedError) {
        return Response.json(
          { error: "group_sailed", sailed_at: err.sailed_at },
          { status: 410 },
        );
      }
      throw err;
    }

    // Accepted invitations are the canonical member list (§18.6).
    const { data: memberRows, error: memberErr } = await db
      .from("invitations")
      .select("invitee_email")
      .eq("group_id", id)
      .eq("status", "accepted");
    if (memberErr) {
      return Response.json({ error: memberErr.message }, { status: 500 });
    }
    const recipients = ((memberRows ?? []) as MemberRow[])
      .map((m) => m.invitee_email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);

    if (recipients.length === 0) {
      return Response.json({ sent: 0, suppressed: 0, failed: 0, reason: "no_recipients" });
    }

    // Tenant + branding context for BrandedLayout render. sendTenantNotification
    // loads its own copy for from-address resolution; we pre-load here for the
    // body render so the visual matches the in-app preview.
    const { data: tenantRow } = await db
      .from("tenants")
      .select("legal_name, mailing_address")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    const { data: brandingRow } = await db
      .from("tenant_branding")
      .select("logo_url, primary_color, secondary_color, accent_color, slogan")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    const tenant = (tenantRow ?? null) as TenantRow | null;
    const branding = (brandingRow ?? null) as BrandingRow | null;

    const tenant_legal_name = tenant?.legal_name ?? "Your travel coordinator";
    const tenant_business_address = tenant?.mailing_address ?? "";
    const groupName = [group.cruise_line, group.ship_name].filter(Boolean).join(" — ") ||
      "Your cruise";

    // Render once per recipient because unsubscribe_url is recipient-specific.
    // Token-style unsubscribe is part of a separate effort — for now use a
    // placeholder that resolves to the recipient's settings page.
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
          unsubscribe_url: "/settings/notifications",
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

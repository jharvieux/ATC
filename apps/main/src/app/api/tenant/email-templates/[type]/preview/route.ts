// Email template preview endpoint.
//
// GET /api/tenant/email-templates/[type]/preview
//   ?sailing_id=<uuid>   — populate sailing variables from cruise_sailings catalog
//   ?booking_id=<uuid>   — populate customer + sailing variables from a booking
//   (no param)           — use registry sample data
//
// Returns text/html of the fully-rendered email (tenant override body wrapped
// in BrandedLayout, or the platform default React Email component with sample
// props for AI-generated sections).
//
// Auth: email_templates:read (all roles)

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { isEmailTemplateType, EMAIL_TEMPLATE_REGISTRY } from "@/lib/email/template-registry";
import { resolveEmailContent, renderOverrideBodyInLayout } from "@/lib/email/template-resolve";
import { buildPreviewHtml } from "@/lib/email/preview-builder";
import { formatMailingAddress } from "@/lib/groups/send-invitation-email";
import type { BrandedLayoutProps } from "@/emails/BrandedLayout";

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface SailingWithShip {
  departure_date: string;
  departure_port: string;
  cruise_ships: { canonical_name: string; cruise_lines: { display_name: string } | null } | null;
}

interface BookingWithContact {
  ship_name: string | null;
  cruise_line: string | null;
  sailing_date: string | null;
  contacts: { first_name: string | null; last_name: string | null } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";

function layoutFromRows(
  tenant: TenantRow,
  branding: BrandingRow | null,
): Omit<BrandedLayoutProps, "children"> {
  return {
    branding: {
      logo_url: branding?.logo_url ?? null,
      primary_color: branding?.primary_color ?? null,
      secondary_color: branding?.secondary_color ?? null,
      accent_color: branding?.accent_color ?? null,
      slogan: branding?.slogan ?? null,
    },
    tenant_legal_name: tenant.legal_name ?? "Your Agency",
    tenant_business_address: formatMailingAddress(tenant.mailing_address),
    unsubscribe_url: `${APP_URL}/email/unsubscribe?token=preview`,
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(
  req: Request,
  { params }: { params: Promise<{ type: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "email_templates", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { ctx } = auth;
  const { type } = await params;

  if (!isEmailTemplateType(type)) {
    return Response.json({ error: "unknown_template_type" }, { status: 400 });
  }

  const spec = EMAIL_TEMPLATE_REGISTRY[type];
  const db = tenantClient(ctx);
  const url = new URL(req.url);
  const sailingId = url.searchParams.get("sailing_id");
  const bookingId = url.searchParams.get("booking_id");

  // ── Fetch tenant + branding ──────────────────────────────────────────────
  const [tenantRes, brandingRes] = await Promise.all([
    db.from("tenants").select("legal_name, mailing_address").eq("id", ctx.tenant_id).single(),
    db
      .from("tenant_branding")
      .select("logo_url, primary_color, secondary_color, accent_color, slogan")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle(),
  ]);

  if (tenantRes.error) return dbErrorResponse(tenantRes.error);
  const layout = layoutFromRows(
    tenantRes.data as TenantRow,
    brandingRes.data as BrandingRow | null,
  );

  // ── Build variables ──────────────────────────────────────────────────────
  // Start with registry sample values, then overlay from sailing/booking.
  const vars: Record<string, string> = {};
  for (const v of spec.variables) {
    vars[v.name] = v.sample;
  }

  if (sailingId) {
    const { data, error } = await db
      .from("cruise_sailings")
      .select(
        "departure_date, departure_port, cruise_ships(canonical_name, cruise_lines(display_name))",
      )
      .eq("id", sailingId)
      .single();

    if (error) return dbErrorResponse(error);
    const row = data as unknown as SailingWithShip;
    if (row.departure_date) vars.sailing_date = row.departure_date;
    if (row.departure_port) vars.departure_port = row.departure_port;
    if (row.cruise_ships?.canonical_name) vars.ship_name = row.cruise_ships.canonical_name;
    if (row.cruise_ships?.cruise_lines?.display_name)
      vars.cruise_line = row.cruise_ships.cruise_lines.display_name;
  } else if (bookingId) {
    const { data, error } = await db
      .from("bookings")
      .select(
        "ship_name, cruise_line, sailing_date, contacts!primary_contact_id(first_name, last_name)",
      )
      .eq("id", bookingId)
      .single();

    if (error) return dbErrorResponse(error);
    const row = data as unknown as BookingWithContact;
    if (row.ship_name) vars.ship_name = row.ship_name;
    if (row.cruise_line) vars.cruise_line = row.cruise_line;
    if (row.sailing_date) vars.sailing_date = row.sailing_date;
    const contact = row.contacts;
    if (contact) {
      const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
      if (name) {
        vars.customer_name = name;
        vars.recipient_name = name;
        vars.invitee_name = name;
      }
    }
  }

  // ── Resolve tenant override, then render ─────────────────────────────────
  const resolved = await resolveEmailContent({
    db,
    tenant_id: ctx.tenant_id,
    email_type: type,
    variables: vars,
  });

  let html: string;
  if (resolved.overrideBodyText !== null) {
    html = await renderOverrideBodyInLayout(layout, resolved.overrideBodyText);
  } else {
    html = await buildPreviewHtml(type, vars, layout);
  }

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// Email template send-preview endpoint.
//
// POST /api/tenant/email-templates/[type]/send-preview
// Body: { to_email: string, sailing_id?: string, booking_id?: string }
//
// Sends a preview of the email template to the specified address.
// Intended for owners to receive the email in their inbox so they can
// review it before customers receive it, or forward it manually.
//
// Auth:  email_templates:write (owner-only)
// Limit: 10 sends per tenant per 24h (template_preview category)

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { isEmailTemplateType, EMAIL_TEMPLATE_REGISTRY } from "@/lib/email/template-registry";
import { resolveEmailContent, renderOverrideBodyInLayout } from "@/lib/email/template-resolve";
import { buildPreviewHtml } from "@/lib/email/preview-builder";
import { sendEmail } from "@/lib/email/send";

interface TenantRow {
  id: string;
  legal_name: string | null;
  mailing_address: string | null;
}

interface BrandingRow {
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  slogan: string | null;
  email_send_pattern: "platform_resend" | "tenant_resend";
  tenant_resend_api_key_encrypted: string | null;
  email_from_address: string | null;
  email_from_name: string | null;
  email_from_domain: string | null;
  email_from_domain_verified_at: string | null;
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

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ type: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "email_templates", action: "write" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { ctx } = auth;
  const { type } = await params;

  if (!isEmailTemplateType(type)) {
    return Response.json({ error: "unknown_template_type" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const toEmail = typeof raw.to_email === "string" ? raw.to_email.trim().slice(0, 254) : null;
  if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
    return Response.json({ error: "invalid_to_email" }, { status: 400 });
  }
  const sailingId = typeof raw.sailing_id === "string" ? raw.sailing_id : null;
  const bookingId = typeof raw.booking_id === "string" ? raw.booking_id : null;

  const spec = EMAIL_TEMPLATE_REGISTRY[type];
  const db = tenantClient(ctx);
  const svc = createServiceRoleClient();

  // ── Fetch tenant + branding ──────────────────────────────────────────────
  const [tenantRes, brandingRes] = await Promise.all([
    db.from("tenants").select("id, legal_name, mailing_address").eq("id", ctx.tenant_id).single(),
    db
      .from("tenant_branding")
      .select(
        "logo_url, primary_color, secondary_color, accent_color, slogan, email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name, email_from_domain, email_from_domain_verified_at",
      )
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle(),
  ]);

  if (tenantRes.error) return dbErrorResponse(tenantRes.error);
  const tenant = tenantRes.data as TenantRow;
  const branding = brandingRes.data as BrandingRow | null;

  const layout = {
    branding: {
      logo_url: branding?.logo_url ?? null,
      primary_color: branding?.primary_color ?? null,
      secondary_color: branding?.secondary_color ?? null,
      accent_color: branding?.accent_color ?? null,
      slogan: branding?.slogan ?? null,
    },
    tenant_legal_name: tenant.legal_name ?? "Your Agency",
    tenant_business_address: tenant.mailing_address ?? "",
    unsubscribe_url: `${APP_URL}/email/unsubscribe?token=preview`,
  };

  // ── Build variables ──────────────────────────────────────────────────────
  const vars: Record<string, string> = {};
  for (const v of spec.variables) {
    vars[v.name] = v.sample;
  }

  if (sailingId) {
    const { data, error } = await db
      // d091-allow:service-role-tenant db = tenantClient (RLS-scoped), not svc; RLS provides isolation
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
      // d091-allow:service-role-tenant db = tenantClient (RLS-scoped), not svc; RLS provides isolation
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

  // ── Resolve + render ─────────────────────────────────────────────────────
  const resolved = await resolveEmailContent({
    db,
    tenant_id: ctx.tenant_id,
    email_type: type,
    variables: vars,
  });

  const html =
    resolved.overrideBodyText !== null
      ? await renderOverrideBodyInLayout(layout, resolved.overrideBodyText)
      : await buildPreviewHtml(type, vars, layout);

  // Prefix subject so the inbox makes it obvious this is a preview.
  const subject = `[Preview] ${resolved.subject}`;

  // ── Send ─────────────────────────────────────────────────────────────────
  const result = await sendEmail({
    db: svc,
    tenant: {
      id: tenant.id,
      legal_name: tenant.legal_name ?? "Your Agency",
      mailing_address: tenant.mailing_address,
      email_send_pattern: branding?.email_send_pattern ?? "platform_resend",
      tenant_resend_api_key_encrypted: branding?.tenant_resend_api_key_encrypted ?? null,
      email_from_address: branding?.email_from_address ?? null,
      email_from_name: branding?.email_from_name ?? null,
      email_from_domain: branding?.email_from_domain ?? null,
      email_from_domain_verified_at: branding?.email_from_domain_verified_at ?? null,
    },
    to: toEmail,
    subject,
    template_id: "template_preview",
    category: "template_preview",
    html,
  });

  if (result.status === "rate_limited") {
    return Response.json(
      { error: "Rate limit reached — maximum 10 preview emails per day." },
      { status: 429 },
    );
  }
  if (result.status === "failed") {
    return Response.json({ error: result.reason ?? "send_failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}

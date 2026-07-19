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
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { isEmailTemplateType, EMAIL_TEMPLATE_REGISTRY } from "@/lib/email/template-registry";
import { resolveEmailContent, renderOverrideBodyInLayout } from "@/lib/email/template-resolve";
import { buildPreviewHtml } from "@/lib/email/preview-builder";
import { sendEmail } from "@/lib/email/send";
import { buildPreviewVars, layoutFromRows, type PreviewTenantRow } from "@/lib/email/preview-vars";
import { isValidEmail } from "@/lib/validation/schemas";

interface TenantRow extends PreviewTenantRow {
  id: string;
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
  if (!toEmail || !isValidEmail(toEmail)) {
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

  const layout = layoutFromRows(tenant, branding);

  // ── Build variables ──────────────────────────────────────────────────────
  const varsResult = await buildPreviewVars(db, spec, sailingId, bookingId);
  if (!varsResult.ok) return varsResult.response;
  const vars = varsResult.vars;

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
      mailing_address: formatMailingAddress(tenant.mailing_address),
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

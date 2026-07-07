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
import {
  buildPreviewVars,
  layoutFromRows,
  type PreviewTenantRow,
  type PreviewBrandingRow,
} from "@/lib/email/preview-vars";

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
    tenantRes.data as PreviewTenantRow,
    brandingRes.data as PreviewBrandingRow | null,
  );

  // ── Build variables ──────────────────────────────────────────────────────
  const varsResult = await buildPreviewVars(db, spec, sailingId, bookingId);
  if (!varsResult.ok) return varsResult.response;
  const vars = varsResult.vars;

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

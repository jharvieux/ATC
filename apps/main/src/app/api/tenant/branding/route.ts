// §16.1 — Tenant branding upsert API.
// GET: returns current tenant_branding row.
// POST: upserts visual brand fields for the calling tenant.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

interface BrandingBody {
  logo_url?: string;
  logo_dark_url?: string;
  favicon_url?: string;
  primary_color?: string;
  secondary_color?: string;
  accent_color?: string;
  font_family?: string;
  slogan?: string;
  about_text?: string;
  email_send_pattern?: "platform_resend" | "tenant_resend";
  email_from_domain?: string;
  email_from_address?: string;
  email_from_name?: string;
  show_powered_by?: boolean;
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

function isValidHex(s: string | undefined | null): boolean {
  return !s || HEX_RE.test(s);
}

// Forced-true tiers per §16.7 — toggle hidden, value coerced to TRUE.
const FORCED_POWERED_BY_TIERS = new Set(["byo_research", "byo_professional", "sub_starter"]);

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "tenant_branding", action: "read" });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
  const { ctx } = auth;

  const db = tenantClient(ctx);
  const { data, error } = await db.from("tenant_branding").select("*").maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ branding: data ?? null });
}

export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "tenant_branding", action: "write" });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
  const { ctx } = auth;

  let body: BrandingBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // Validate hex colors.
  if (!isValidHex(body.primary_color) || !isValidHex(body.secondary_color) || !isValidHex(body.accent_color)) {
    return Response.json({ error: "invalid_color_hex" }, { status: 422 });
  }

  // Length caps.
  if (body.slogan && body.slogan.length > 200) {
    return Response.json({ error: "slogan_too_long" }, { status: 422 });
  }
  if (body.about_text && body.about_text.length > 2000) {
    return Response.json({ error: "about_text_too_long" }, { status: 422 });
  }

  const db = tenantClient(ctx);

  // Read tier to enforce powered-by forcing per §16.7.
  const { data: tenant } = await db.from("tenants").select("tier_id").eq("id", ctx.tenant_id).maybeSingle();
  let forcePoweredBy = false;
  if (tenant) {
    const { data: tier } = await db
      .from("tier_definitions")
      .select("code")
      .eq("id", (tenant as { tier_id: string }).tier_id)
      .maybeSingle();
    if (tier && FORCED_POWERED_BY_TIERS.has((tier as { code: string }).code)) {
      forcePoweredBy = true;
    }
  }

  const showPoweredBy = forcePoweredBy ? true : (body.show_powered_by ?? true);

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    show_powered_by: showPoweredBy,
  };
  if (body.logo_url !== undefined) payload.logo_url = body.logo_url;
  if (body.logo_dark_url !== undefined) payload.logo_dark_url = body.logo_dark_url;
  if (body.favicon_url !== undefined) payload.favicon_url = body.favicon_url;
  if (body.primary_color !== undefined) payload.primary_color = body.primary_color;
  if (body.secondary_color !== undefined) payload.secondary_color = body.secondary_color;
  if (body.accent_color !== undefined) payload.accent_color = body.accent_color;
  if (body.font_family !== undefined) payload.font_family = body.font_family;
  if (body.slogan !== undefined) payload.slogan = body.slogan;
  if (body.about_text !== undefined) payload.about_text = body.about_text;
  if (body.email_send_pattern !== undefined) payload.email_send_pattern = body.email_send_pattern;
  if (body.email_from_domain !== undefined) payload.email_from_domain = body.email_from_domain;
  if (body.email_from_address !== undefined) payload.email_from_address = body.email_from_address;
  if (body.email_from_name !== undefined) payload.email_from_name = body.email_from_name;

  const { data, error } = await db
    .from("tenant_branding")
    .upsert(payload, { onConflict: "tenant_id" })
    .select("id")
    .single();

  if (error || !data) {
    return Response.json({ error: error?.message ?? "upsert_failed" }, { status: 500 });
  }

  return Response.json({ ok: true, branding_id: (data as { id: string }).id, show_powered_by: showPoweredBy });
}

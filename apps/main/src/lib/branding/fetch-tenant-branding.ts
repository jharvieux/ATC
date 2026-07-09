// Anonymous-safe read of a tenant's branding row, used by the public
// landing page when the visitor is on a tenant subdomain. The
// authenticated user (if any) doesn't matter — every anonymous visitor
// to acme.ai-travelconcierge.com should see acme's branding, so RLS
// (which gates tenant_branding to authenticated tenant members) won't
// work here. Service-role bypasses RLS; the fields returned are
// public-marketing-only (display_name, logo URLs, slogan, theme colors,
// font, favicon), never PII or credentials.

import "server-only";

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export interface TenantBranding {
  display_name: string;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  slogan: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  font_family: string | null;
}

/**
 * Fetch the public branding fields for a tenant by id. Returns null for
 * platform-domain requests, deleted/inactive tenants, or any DB error
 * the caller can safely fall back from (the landing then renders the
 * generic platform hero instead of 500-ing on a branding-fetch hiccup).
 *
 * `tenantId === "platform"` is the platform-domain sentinel emitted by
 * proxy.ts when no tenant subdomain resolved — handled explicitly so
 * callers can pass the header value straight through.
 */
export async function fetchTenantBranding(
  tenantId: string | null,
): Promise<TenantBranding | null> {
  if (!tenantId || tenantId === "platform") return null;

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("tenants")
    .select(
      "display_name, status, tenant_branding(logo_url, logo_dark_url, favicon_url, slogan, primary_color, secondary_color, accent_color, font_family)",
    )
    .eq("id", tenantId)
    .maybeSingle();

  // `.maybeSingle()` returns `{ data: null, error: null }` for zero rows
  // — not-found is handled by the `!data` check below. Anything in
  // `error` here is a real DB/network failure that should 500 rather
  // than silently degrade to the platform hero. (`.single()` would have
  // emitted PGRST116 on zero rows, but we deliberately use maybeSingle.)
  if (error) throw new Error(`fetchTenantBranding: ${error.message}`);
  if (!data || data.status !== "active") return null;

  // PostgREST returns the nested embed as an array when it can't detect
  // a 1-to-1 constraint, and as a plain object (or null) when it can.
  // Guard both cases: null (no branding row), array (legacy/many), object
  // (1-to-1 detected).
  type BrandingFields = {
    logo_url: string | null;
    logo_dark_url: string | null;
    favicon_url: string | null;
    slogan: string | null;
    primary_color: string | null;
    secondary_color: string | null;
    accent_color: string | null;
    font_family: string | null;
  };
  const row = data as unknown as {
    display_name: string;
    status: string;
    tenant_branding: BrandingFields[] | BrandingFields | null;
  };
  const tb = row.tenant_branding;
  const branding: BrandingFields | null = Array.isArray(tb)
    ? (tb[0] ?? null)
    : (tb ?? null);
  return {
    display_name: row.display_name,
    logo_url: branding?.logo_url ?? null,
    logo_dark_url: branding?.logo_dark_url ?? null,
    favicon_url: branding?.favicon_url ?? null,
    slogan: branding?.slogan ?? null,
    primary_color: branding?.primary_color ?? null,
    secondary_color: branding?.secondary_color ?? null,
    accent_color: branding?.accent_color ?? null,
    font_family: branding?.font_family ?? null,
  };
}

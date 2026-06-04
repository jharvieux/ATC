// Anonymous-safe read of a tenant's branding row, used by the public
// landing page when the visitor is on a tenant subdomain. The
// authenticated user (if any) doesn't matter — every anonymous visitor
// to acme.ai-travelconcierge.com should see acme's branding, so RLS
// (which gates tenant_branding to authenticated tenant members) won't
// work here. Service-role bypasses RLS; the fields returned are
// public-marketing-only (display_name, logo URLs, slogan), never PII
// or credentials.

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export interface TenantBranding {
  display_name: string;
  logo_url: string | null;
  logo_dark_url: string | null;
  slogan: string | null;
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
    .select("display_name, status, tenant_branding(logo_url, logo_dark_url, slogan)")
    .eq("id", tenantId)
    .maybeSingle();

  // A truly broken DB connection should surface as 500 — but a NotFound
  // or RLS-denial here is silent fallback territory because the landing
  // has a perfectly good platform-hero default. Only re-throw on the
  // shapes that mean "we genuinely could not query."
  if (error) {
    if (error.code === "PGRST116" || error.code === "PGRST204") return null;
    throw new Error(`fetchTenantBranding: ${error.message}`);
  }
  if (!data || data.status !== "active") return null;

  // Supabase nested-select returns the joined table as an array even
  // for a 1:1 relation. tenant_branding is uniqued on tenant_id so
  // there's at most one row; pick [0].
  const row = data as unknown as {
    display_name: string;
    status: string;
    tenant_branding: Array<{ logo_url: string | null; logo_dark_url: string | null; slogan: string | null }>;
  };
  const branding = row.tenant_branding[0] ?? null;
  return {
    display_name: row.display_name,
    logo_url: branding?.logo_url ?? null,
    logo_dark_url: branding?.logo_dark_url ?? null,
    slogan: branding?.slogan ?? null,
  };
}

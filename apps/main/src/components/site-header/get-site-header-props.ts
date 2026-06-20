// Helper to compute the SiteHeader props from the request that called a
// server component or layout. Keeps the auth-check + domain-check
// boilerplate in one place rather than duplicated across every page that
// renders the header.

import { headers } from "next/headers";
import { getCachedUser } from "@/lib/auth/get-cached-user";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { getTenantRole } from "@/lib/auth/resolve-post-login";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { extractUserDisplayMeta } from "@/lib/auth/user-meta";
import type { SiteHeaderProps } from "./SiteHeader";

export async function getSiteHeaderProps(): Promise<SiteHeaderProps> {
  const incoming = await headers();

  // Platform vs tenant — the middleware sets x-resolved-tenant-id to
  // "platform" on the platform domain and a UUID on any tenant subdomain.
  // Missing header (rare, e.g. local dev hitting an unmiddlewared path)
  // is treated as platform — safer for the marketing chrome since the
  // tenant variant currently has no extra surface.
  const resolved = incoming.get(RESOLVED_TENANT_ID_HEADER);
  const isPlatformDomain = !resolved || resolved === "platform";

  // Request-scoped memoization (#667): when this layout + its rendered
  // page both need auth state, share one Supabase JWT verification per
  // request rather than running it twice. See get-cached-user.ts.
  const { isAuthenticated, user } = await getCachedUser();

  // §16 — tenant subdomains show the tenant's logo in the chrome.
  // Request-memoized alongside the theme injector and layout metadata.
  const tenantBranding = isPlatformDomain
    ? null
    : await getRequestTenantBranding();

  // Role for the hamburger nav — only meaningful on tenant subdomains where
  // the user has an active membership. Null on the platform domain, for
  // anonymous visitors, or on DB error (fail-safe: shows generic menu).
  let role: SiteHeaderProps["role"] = null;
  if (!isPlatformDomain && isAuthenticated && user && resolved) {
    try {
      role = await getTenantRole(user.id, resolved);
    } catch (err) {
      console.error("[get-site-header-props] getTenantRole failed:", err);
    }
  }

  const { avatarUrl, displayName } = extractUserDisplayMeta(user);

  return { isPlatformDomain, isAuthenticated, tenantBranding, role, avatarUrl, displayName };
}

// Shared chrome for the tenant Admin Console (settings/*, tenant-admin/*).
// These pages were moved out of the (tenant) group (#962 follow-up) so they
// can render their own shell: platform logo + collapsible left sidebar,
// instead of the tenant-branded SiteHeader. Route-group names in parens are
// URL-invisible, so every /settings/* and /tenant-admin/* URL is unchanged.
//
// Like the old (tenant) layout, this does NOT gate — page-level
// assertPermission is the authoritative check (server components 403/redirect;
// client components hit APIs that 401). The role resolved here only drives
// which sidebar sections show; when no role resolves (anonymous, or a member
// of a different tenant) we render bare and let the page's own gate redirect.

import React from "react";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { TenantTheme } from "@/components/branding/TenantTheme";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { getCachedUser } from "@/lib/auth/get-cached-user";
import { getTenantRole } from "@/lib/auth/resolve-post-login";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { ConsoleShell } from "@/components/tenant-console/ConsoleShell";
import {
  COOKIE_NAME,
  parseCollapsedCookie,
} from "@/components/tenant-console/collapsed-cookie";

// §16 — keep the tenant's name + favicon in the tab (unchanged by the move).
// The platform branding decision is about the visible chrome logo, not the
// tab title.
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getRequestTenantBranding();
  if (!branding) return {};
  return {
    title: branding.display_name,
    ...(branding.favicon_url ? { icons: { icon: branding.favicon_url } } : {}),
  };
}

export default async function ConsoleLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const incoming = await headers();
  const tenantId = incoming.get(RESOLVED_TENANT_ID_HEADER);
  const { user } = await getCachedUser();
  const role =
    user && tenantId && tenantId !== "platform"
      ? await getTenantRole(user.id, tenantId)
      : null;

  // Persisted sidebar-collapsed state, read server-side so the first SSR
  // paint matches the saved state — no flash (#669).
  const initialCollapsed = parseCollapsedCookie(
    (await cookies()).get(COOKIE_NAME)?.value,
  );

  if (!role) {
    return (
      <>
        <TenantTheme />
        {children}
      </>
    );
  }

  return (
    <>
      <TenantTheme />
      <ConsoleShell role={role} initialCollapsed={initialCollapsed}>
        {children}
      </ConsoleShell>
    </>
  );
}

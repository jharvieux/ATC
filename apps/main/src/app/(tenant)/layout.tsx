// Shared chrome for the staff-only tenant-area pages (crm/*, concierge/*).
// (settings/* and tenant-admin/* moved to the (console) group.) Adds the
// SiteHeader on top so the hamburger menu and login state are consistent.
//
// Platform branding (#962 follow-up): this whole group is staff-facing, so
// the header shows the AI Travel Concierge logo, never tenant white-label
// (that stays on end-customer surfaces). We pass tenantBranding={null} to
// force the platform logo while keeping isPlatformDomain/isAuthenticated.
// TenantTheme still applies the tenant's colors/font — only the logo changes.
//
// Page-level auth is enforced per-page (server components call
// assertPermission; client components hit APIs that 401). This layout
// itself does NOT gate — render anonymously and the SiteHeader will
// just show the Log in button.

import React from "react";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header/SiteHeader";
import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import { BrandingSetupBannerServer } from "@/components/branding-setup-banner/BrandingSetupBannerServer";
import { TenantTheme } from "@/components/branding/TenantTheme";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { ConversationRailDrawer } from "@/components/crm/ConversationRailDrawer";

// §16 — tenant subdomains carry the tenant's name + favicon in the tab.
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getRequestTenantBranding();
  if (!branding) return {};
  return {
    title: branding.display_name,
    ...(branding.favicon_url ? { icons: { icon: branding.favicon_url } } : {}),
  };
}

export default async function TenantAreaLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const headerProps = await getSiteHeaderProps();
  const isStaff = headerProps.role === "tenant_owner" || headerProps.role === "agent";
  return (
    <>
      <TenantTheme />
      <SiteHeader
        {...headerProps}
        tenantBranding={null}
        leftSlot={isStaff ? <ConversationRailDrawer /> : undefined}
      />
      <BrandingSetupBannerServer />
      {children}
    </>
  );
}

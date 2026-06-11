// Shared chrome for every tenant-area page (crm/*, settings/*,
// tenant-admin/*). Adds the SiteHeader on top so the logo, hamburger
// menu, and login state are consistent across the tenant surface.
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
  return (
    <>
      <TenantTheme />
      <SiteHeader {...headerProps} />
      <BrandingSetupBannerServer />
      {children}
    </>
  );
}

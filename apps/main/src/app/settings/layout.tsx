// §16.2 follow-up (#1008) — shared layout for the personal "My account"
// settings pages (conversations, price-watches, privacy, profile, memory).
// Injects TenantTheme (colors + font) and sets the tab title/favicon from
// branding, matching the (tenant) area layout.
//
// Also renders the canonical role-aware SiteHeader so these pages aren't
// dead-ended: previously they had no chrome at all, so picking "Conversations"
// or "Privacy" from the hamburger landed you on a page with no way back to
// CRM/Dashboard. The hamburger here is the same menu shown on the dashboard,
// CRM pages, and Admin Console — consistent navigation on every tenant screen.
//
// Branding: this surface serves all roles, so staff get the platform logo
// (the #962 staff-facing rule) while customers keep their tenant white-label.

import * as React from "react";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header/SiteHeader";
import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import { TenantTheme } from "@/components/branding/TenantTheme";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getRequestTenantBranding();
  if (!branding) return {};
  return {
    title: branding.display_name,
    ...(branding.favicon_url ? { icons: { icon: branding.favicon_url } } : {}),
  };
}

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const headerProps = await getSiteHeaderProps();
  const isStaff =
    headerProps.role === "tenant_owner" || headerProps.role === "agent";
  return (
    <>
      <TenantTheme />
      <SiteHeader
        {...headerProps}
        tenantBranding={isStaff ? null : headerProps.tenantBranding}
      />
      {children}
    </>
  );
}

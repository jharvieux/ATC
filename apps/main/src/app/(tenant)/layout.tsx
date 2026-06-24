// Shared chrome for staff-only tenant-area pages (crm/*, concierge/*).
// (settings/* and tenant-admin/* moved to the (console) group.)
//
// Platform branding (#962 follow-up): whole group is staff-facing so the
// header shows AI Travel Concierge logo, never tenant white-label.
// TenantTheme still applies tenant's colors/font — only the logo changes.
//
// Sidebar: staff members get the persistent WorkspaceSidebar on every page
// reachable from it (fixes "stranding" — nav was only visible on the root
// dashboard, not on the CRM/concierge pages it links to). WorkspaceSidebar
// self-manages its collapsed/expanded state; this layout just passes the role.
//
// Layout structure (h-screen flex-col so the sidebar fills available height):
//   ┌─ SiteHeader ───────────────────────────────────────┐
//   ├─ BrandingSetupBanner (if present) ─────────────────┤
//   │ WorkspaceSidebar │ main (overflow-auto, scrolls)   │
//   └──────────────────┴──────────────────────────────────┘
//
// Page-level auth is enforced per-page; this layout does NOT gate.

import React from "react";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header/SiteHeader";
import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import { BrandingSetupBannerServer } from "@/components/branding-setup-banner/BrandingSetupBannerServer";
import { TenantTheme } from "@/components/branding/TenantTheme";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { ConversationRailDrawer } from "@/components/crm/ConversationRailDrawer";
import { WorkspaceSidebar } from "@/components/tenant-shell/WorkspaceSidebar";

// §16 — tenant subdomains carry tenant's name + favicon in tab.
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
    <div className="flex h-screen flex-col">
      <TenantTheme />
      <SiteHeader
        {...headerProps}
        tenantBranding={null}
        leftSlot={isStaff ? <ConversationRailDrawer /> : undefined}
      />
      <BrandingSetupBannerServer />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {isStaff && headerProps.role && (
          <WorkspaceSidebar role={headerProps.role} />
        )}
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

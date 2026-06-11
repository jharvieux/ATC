// §16.2 follow-up (#1008) — shared layout for customer settings pages.
// These pages have no shared layout, so tenant theming was absent. This
// injects TenantTheme (colors + font) and sets the tab title/favicon from
// branding, matching the behavior of the (tenant) area layout.

import * as React from "react";
import type { Metadata } from "next";
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

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <TenantTheme />
      {children}
    </>
  );
}

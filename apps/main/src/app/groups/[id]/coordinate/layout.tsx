// §18.11 — Coordinator portal layout with 5-tab navigation.
// Tabs: Overview, Invitees, Edit, Preview Email, Forum.
//
// Restyled to the group-landing "Bright & Vacation-y" identity
// (specs/design_handoff_group_landing/) — same visual language as the
// customer-facing invite page, applied here as a fuller relayout rather
// than a token swap. The cruise-theme chrome (nav, tab
// highlighting, theme toggle) lives in CoordinatorShell, a client component,
// since useCruiseTheme/quicksand need "use client" while this layout must
// stay an async server component to read tenant branding via headers().
//
// <TenantTheme/> is intentionally NOT rendered here anymore: it injects the
// tenant's colors/font as unscoped :root CSS, which would fight this fixed
// cruise identity — same tradeoff group/invite/[token]/page.tsx made. The
// tenant's display_name/logo are still shown, via the same
// getRequestTenantBranding() call TenantTheme used internally, passed into
// CoordinatorShell's header instead.

import * as React from "react";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { CoordinatorShell } from "@/components/groups/CoordinatorShell";

type LayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
};

export default async function CoordinateLayout({
  children,
  params,
}: LayoutProps): Promise<React.ReactElement> {
  const { id } = await params;
  const branding = await getRequestTenantBranding();

  return (
    <CoordinatorShell
      groupId={id}
      tenantDisplayName={branding?.display_name ?? null}
      tenantLogoUrl={branding?.logo_url ?? null}
    >
      {children}
    </CoordinatorShell>
  );
}

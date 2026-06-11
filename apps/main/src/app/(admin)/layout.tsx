// §26 — Platform-admin gate for the entire (admin) route group (/admin/*,
// /supervisor/*). Every page in this group renders only after
// assertPlatformAdmin verifies the caller (cookie session → platform_admins,
// or the service-to-service bearer). This is the authoritative page-level
// check; proxy.ts adds a coarse shape-check + host restriction as a second
// layer (the codebase's two-layer admin model — see proxy.ts §26).
//
// Why this exists: server-component admin pages (e.g. /supervisor) read the
// database directly with a service-role client, so without a page-level gate
// they render cross-tenant data to anyone. The middleware only gated
// /api/admin/*, not the pages (security issue #559).
//
// Fail-closed: ANY failure — unauthenticated, authenticated-but-not-an-admin,
// or a verification error — resolves to notFound(), which also avoids
// disclosing that the admin surface exists. assertPlatformAdmin reads only the
// `authorization` and `cookie` headers, so we forward those onto a synthetic
// Request to reuse the route-handler gate verbatim.

import React from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getCachedAdminContext } from "@/lib/auth/assert-platform-admin";
import { AdminShell } from "@/components/admin-shell/AdminShell";
import { COOKIE_NAME, parseCollapsedCookie } from "@/components/admin-shell/collapsed-cookie";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  // getCachedAdminContext uses React.cache — shared with any page that
  // calls it too, so layout + page = one DB round-trip.
  const ctx = await getCachedAdminContext();
  if (!ctx) {
    notFound();
  }

  // Read the persisted sidebar-collapsed state cookie-side so the initial
  // SSR HTML matches the operator's saved state — no all-open-flash on
  // hydration (#669).
  const initialCollapsed = parseCollapsedCookie(
    (await cookies()).get(COOKIE_NAME)?.value,
  );

  return (
    <AdminShell initialCollapsed={initialCollapsed} adminRole={ctx.role}>
      {children}
    </AdminShell>
  );
}

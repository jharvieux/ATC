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
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { assertPlatformAdmin } from "@/lib/auth/assert-platform-admin";
import { AdminShell } from "@/components/admin-shell/AdminShell";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const incoming = await headers();
  const forwarded = new Headers();
  const cookie = incoming.get("cookie");
  if (cookie) forwarded.set("cookie", cookie);
  const authorization = incoming.get("authorization");
  if (authorization) forwarded.set("authorization", authorization);

  try {
    await assertPlatformAdmin(
      new Request("https://admin.internal/", { headers: forwarded }),
    );
  } catch {
    notFound();
  }

  return <AdminShell>{children}</AdminShell>;
}

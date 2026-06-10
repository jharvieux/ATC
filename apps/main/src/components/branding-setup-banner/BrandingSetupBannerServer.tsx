// Server-only async component that decides whether the branding-setup
// banner should appear for the current request. All DB reads here are
// display-only; errors return null (don't show the banner) rather than
// throwing — a hiccup in branding-state detection should never interrupt
// a tenant admin's workflow.
//
// Render conditions (all must be true):
//   1. x-resolved-tenant-id header is set and not "platform"
//   2. The visitor is authenticated
//   3. The visitor's membership in this tenant has role === "tenant_owner"
//   4. The tenant's branding row has no logo_url

import { headers } from "next/headers";
import { getCachedUser } from "@/lib/auth/get-cached-user";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { BrandingSetupBannerClient } from "./BrandingSetupBannerClient";

export async function BrandingSetupBannerServer() {
  const incoming = await headers();
  const tenantId = incoming.get(RESOLVED_TENANT_ID_HEADER);

  // Not a tenant-domain request — banner doesn't apply.
  if (!tenantId || tenantId === "platform") return null;

  const { user } = await getCachedUser();
  if (!user) return null;

  const svc = createServiceRoleClient();

  // Two-layer tenant isolation: service-role client (bypasses RLS) +
  // explicit .eq("tenant_id", tenantId) on every query below.
  const { data: membership } = await svc
    .from("tenant_memberships")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("auth_user_id", user.id)
    .maybeSingle();

  // No membership or not a tenant_owner — banner is not relevant.
  if (!membership || membership.role !== "tenant_owner") return null;

  const { data: branding } = await svc
    .from("tenant_branding")
    .select("logo_url")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  // Logo already configured — nothing to prompt about.
  if (branding?.logo_url) return null;

  return <BrandingSetupBannerClient tenantId={tenantId} />;
}

// Request-scoped read of the resolved tenant's tier code, for server
// components (layouts) that gate UI by tier and therefore have no
// assertPermission ctx to scope an RLS-aware client with.
//
// RLS on tenants/tier_definitions requires authenticated tenant
// membership; a layout render can precede that resolution, and the tier
// code is non-PII plan metadata (never credentials or customer data).
// Read-only, service-role — same sanctioned pattern as
// fetch-tenant-branding.ts.

import "server-only";

import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { getTenantTierCode } from "@/lib/tenancy/get-tenant-tier-code";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

/** Tier code for the tenant resolved by proxy.ts for the current request.
 *  Null on the platform domain or when middleware didn't resolve a tenant. */
export async function getRequestTenantTierCode(): Promise<string | null> {
  const incoming = await headers();
  const tenantId = incoming.get(RESOLVED_TENANT_ID_HEADER);
  if (!tenantId || tenantId === "platform") return null;

  return getTenantTierCode(createServiceRoleClient(), tenantId);
}

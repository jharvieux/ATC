import "server-only";

import { getCurrentIndexingTenantByCustomDomain } from "@/lib/tenancy/resolve-tenant";
import { isIndexableHost, normalizeHost, siteOrigin } from "@/lib/seo/site";

const AGENCY_TIERS = new Set(["sub_agency", "byo_agency"]);

export interface IndexingTarget {
  kind: "platform" | "tenant";
  origin: string;
}

/**
 * Resolves the host that a crawler may index. Lookup failures deny indexing;
 * they must never turn an enforcement outage into an accidental opt-in.
 */
export async function resolveIndexingTarget(
  host: string | null,
): Promise<IndexingTarget | null> {
  if (isIndexableHost(host)) {
    return { kind: "platform", origin: siteOrigin() };
  }

  const hostname = normalizeHost(host);
  const primary = process.env.PLATFORM_PRIMARY_DOMAIN?.toLowerCase();
  if (
    !hostname ||
    !primary ||
    hostname.endsWith(`.${primary}`) ||
    hostname.endsWith(".vercel.app")
  ) {
    return null;
  }

  try {
    const tenant = await getCurrentIndexingTenantByCustomDomain(hostname);
    if (
      tenant?.status !== "active" ||
      tenant.custom_domain !== hostname ||
      tenant.custom_domain_status !== "verified" ||
      tenant.search_indexing_enabled !== true ||
      !tenant.tier_code ||
      !AGENCY_TIERS.has(tenant.tier_code)
    ) {
      return null;
    }
    return { kind: "tenant", origin: `https://${hostname}` };
  } catch (error) {
    console.error("[seo] custom-domain indexing lookup failed", error);
    return null;
  }
}

// Request-scoped memoization of fetchTenantBranding for the resolved
// tenant of the current request. A tenant-subdomain page render touches
// branding from several places (theme injector, site header, layout
// metadata, hero) — wrap once with React.cache so they share one
// service-role round-trip per request.
//
// Lives apart from fetch-tenant-branding.ts so the pure fetcher stays
// testable without mocking next/headers.

import { cache as reactCache } from "react";
import { headers } from "next/headers";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { fetchTenantBranding, type TenantBranding } from "./fetch-tenant-branding";

// Same shim as get-cached-user.ts: react.cache exists in Next's server
// runtime but can resolve to undefined in vitest's node env. Passthrough
// outside production; fail loudly in production where a missing cache
// would silently multiply branding queries per render.
type CacheFn = <T extends (...a: never[]) => unknown>(fn: T) => T;
const cache: CacheFn = (() => {
  if (typeof reactCache === "function") return reactCache as CacheFn;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "request-branding: react.cache is not a function in production — " +
        "request memoization would silently break, multiplying branding " +
        "queries per page render.",
    );
  }
  return (fn) => fn;
})();

/**
 * Branding for the tenant resolved by proxy.ts for the current request.
 * Null on the platform domain, for inactive tenants, or when middleware
 * didn't resolve a tenant.
 */
export const getRequestTenantBranding = cache(
  async (): Promise<TenantBranding | null> => {
    const incoming = await headers();
    return fetchTenantBranding(incoming.get(RESOLVED_TENANT_ID_HEADER));
  },
);

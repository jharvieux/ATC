// Spec ref: §1.4 (tenant resolution), BP04
//
// Service-role imports are permitted here: middleware runs before any user
// context exists, so there is no tenant JWT to attach. This file is in the
// no-direct-service-role-import allowlist.

import { createServiceRoleClient } from "@/lib/db/service-role-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tenant = {
  id: string;
  slug: string;
  tenant_type: string;
  status: string;
  custom_domain: string | null;
  // §15.16 — fields the middleware payment gate reads (PR #118 /
  // /lib/billing/payment-state.ts). Cached alongside the rest of the
  // tenant row so a payment-state lookup doesn't cost a second DB hit.
  subscription_status: string | null;
  non_paying_since: string | null;
};

// ---------------------------------------------------------------------------
// In-memory cache — best-effort, 60-second TTL
//
// Edge instances each have their own cache; a cold instance will miss and
// hit the DB. This is intentional per the spec ("Cache invalidation is
// best-effort"). The cache is keyed by the lookup value (slug or hostname).
// ---------------------------------------------------------------------------

type CacheEntry = { tenant: Tenant | null; expiresAt: number };

const slugCache = new Map<string, CacheEntry>();
const domainCache = new Map<string, CacheEntry>();

const TTL_MS = 60_000;

function cacheGet(
  map: Map<string, CacheEntry>,
  key: string,
): Tenant | null | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    map.delete(key);
    return undefined;
  }
  return entry.tenant;
}

function cacheSet(
  map: Map<string, CacheEntry>,
  key: string,
  tenant: Tenant | null,
): void {
  map.set(key, { tenant, expiresAt: Date.now() + TTL_MS });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const TENANT_COLUMNS = "id, slug, tenant_type, status, custom_domain, subscription_status, non_paying_since";

/**
 * Resolves a subdomain slug to a tenant.
 * Returns null for unknown slugs or terminated tenants.
 */
export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const cached = cacheGet(slugCache, slug);
  if (cached !== undefined) return cached;

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("tenants")
    .select(TENANT_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    // Surface the error so the caller can decide how to respond.
    throw new Error(`getTenantBySlug: ${error.message}`);
  }

  const tenant = data?.status === "terminated" ? null : (data as Tenant | null);
  cacheSet(slugCache, slug, tenant);
  return tenant;
}

const userTenantCache = new Map<string, CacheEntry>();

/**
 * Resolves an authenticated user's primary tenant.
 * Used by middleware to let platform-domain users access tenant-scoped
 * paths (e.g. /chat) without being blocked by the "platform" sentinel.
 * Takes the earliest-created active users row when a user belongs to
 * multiple tenants.
 */
export async function getTenantByAuthUserId(
  authUserId: string,
): Promise<Tenant | null> {
  const cached = cacheGet(userTenantCache, authUserId);
  if (cached !== undefined) return cached;

  const db = createServiceRoleClient();
  const { data: userRow } = await db
    .from("users")
    .select("tenant_id")
    .eq("auth_user_id", authUserId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!userRow) {
    cacheSet(userTenantCache, authUserId, null);
    return null;
  }

  const { data, error } = await db
    .from("tenants")
    .select(TENANT_COLUMNS)
    .eq("id", (userRow as { tenant_id: string }).tenant_id)
    .maybeSingle();

  if (error) throw new Error(`getTenantByAuthUserId: ${error.message}`);

  const tenant = data?.status === "terminated" ? null : (data as Tenant | null);
  cacheSet(userTenantCache, authUserId, tenant);
  return tenant;
}

/**
 * Resolves a bare hostname (custom domain) to a tenant.
 * Returns null for unknown domains or terminated tenants.
 */
export async function getTenantByCustomDomain(
  hostname: string,
): Promise<Tenant | null> {
  const cached = cacheGet(domainCache, hostname);
  if (cached !== undefined) return cached;

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("tenants")
    .select(TENANT_COLUMNS)
    .eq("custom_domain", hostname)
    .maybeSingle();

  if (error) {
    throw new Error(`getTenantByCustomDomain: ${error.message}`);
  }

  const tenant = data?.status === "terminated" ? null : (data as Tenant | null);
  cacheSet(domainCache, hostname, tenant);
  return tenant;
}

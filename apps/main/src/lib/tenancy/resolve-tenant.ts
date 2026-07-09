// Spec ref: §1.4 (tenant resolution), BP04
//
// Service-role imports are permitted here: middleware runs before any user
// context exists, so there is no tenant JWT to attach. This file is in the
// no-direct-service-role-import allowlist.

import "server-only";

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { BoundedTtlCache } from "@/lib/cache/bounded-ttl-cache";

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
  // #699 — ATC-owned tenants (e.g. "Booking", ATC's direct-customer
  // business) bypass the payment gate. The platform doesn't bill itself.
  is_platform_internal: boolean;
};

// ---------------------------------------------------------------------------
// In-memory cache — best-effort, 60-second TTL
//
// Edge instances each have their own cache; a cold instance will miss and
// hit the DB. This is intentional per the spec ("Cache invalidation is
// best-effort"). The cache is keyed by the lookup value (slug or hostname).
// ---------------------------------------------------------------------------

const TTL_MS = 60_000;

// #1678 — per-site sizing. slug/domain/id are keyed per TENANT: this is a B2B
// multi-tenant platform (cruise/travel agencies), so tenant count is orders
// of magnitude below 1000 for the foreseeable future — default is fine.
const slugCache = new BoundedTtlCache<string, Tenant | null>({ defaultTtlMs: TTL_MS });
const domainCache = new BoundedTtlCache<string, Tenant | null>({ defaultTtlMs: TTL_MS });
// userTenantCache is keyed per AUTHENTICATED USER, not per tenant — active-user
// count can run well above tenant count. Sized to 5000 so a busy instance
// doesn't fall back to a DB read per user once concurrent active users exceed
// the old 1000 default (the #1678 regression risk).
const userTenantCache = new BoundedTtlCache<string, Tenant | null>({ defaultTtlMs: TTL_MS, maxEntries: 5000 });
const idCache = new BoundedTtlCache<string, Tenant | null>({ defaultTtlMs: TTL_MS });

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const TENANT_COLUMNS = "id, slug, tenant_type, status, custom_domain, subscription_status, non_paying_since, is_platform_internal";

/**
 * Resolves a subdomain slug to a tenant.
 * Returns null for unknown slugs or terminated tenants.
 */
export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const cached = slugCache.get(slug);
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
  slugCache.set(slug, tenant);
  return tenant;
}

/**
 * Resolves a tenant by its id. Used by the middleware to map Vercel preview
 * hostnames to the configured default tenant (PLATFORM_DEFAULT_TENANT_ID).
 * Returns null for unknown ids or terminated tenants.
 */
export async function getTenantById(id: string): Promise<Tenant | null> {
  const cached = idCache.get(id);
  if (cached !== undefined) return cached;

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("tenants")
    .select(TENANT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`getTenantById: ${error.message}`);
  }

  const tenant = data?.status === "terminated" ? null : (data as Tenant | null);
  idCache.set(id, tenant);
  return tenant;
}

/** Earliest-created active users row wins when a user belongs to multiple tenants. */
export async function getTenantByAuthUserId(
  authUserId: string,
): Promise<Tenant | null> {
  const cached = userTenantCache.get(authUserId);
  if (cached !== undefined) return cached;

  const db = createServiceRoleClient();
  const { data: userRow, error: userError } = await db
    .from("users")
    .select("tenant_id")
    .eq("auth_user_id", authUserId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (userError) throw new Error(`getTenantByAuthUserId users lookup: ${userError.message}`);

  if (!userRow) {
    userTenantCache.set(authUserId, null);
    return null;
  }

  const { data, error } = await db
    .from("tenants")
    .select(TENANT_COLUMNS)
    .eq("id", (userRow as { tenant_id: string }).tenant_id)
    .maybeSingle();

  if (error) throw new Error(`getTenantByAuthUserId: ${error.message}`);

  const tenant = data?.status === "terminated" ? null : (data as Tenant | null);
  userTenantCache.set(authUserId, tenant);
  return tenant;
}

/**
 * Resolves a bare hostname (custom domain) to a tenant.
 * Returns null for unknown domains or terminated tenants.
 */
export async function getTenantByCustomDomain(
  hostname: string,
): Promise<Tenant | null> {
  const cached = domainCache.get(hostname);
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
  domainCache.set(hostname, tenant);
  return tenant;
}

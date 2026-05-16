/**
 * Cross-tenant fixture setup.
 *
 * TODO: Implement once the application schema exists.
 * This helper should create two tenants (A and B), one user each,
 * seed resources (bookings, conversations, price_watches, quotes, etc.)
 * owned by each tenant, and return their session tokens + resource IDs.
 *
 * See spec §30.4 for the full fixture spec.
 */

export interface TenantFixture {
  tenantId: string;
  userId: string;
  /** JWT session token for this user */
  sessionToken: string;
  /** Sample resource IDs owned by this tenant, keyed by resource type */
  resourceIds: Record<string, string>;
}

export interface CrossTenantFixtures {
  tenantA: TenantFixture;
  tenantB: TenantFixture;
}

/**
 * Set up two-tenant fixtures against the given Supabase instance.
 * Idempotent — safe to call multiple times; existing fixtures are reused.
 */
export async function setupCrossTenantFixtures(
  supabaseUrl: string, // eslint-disable-line @typescript-eslint/no-unused-vars
  serviceRoleKey: string, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<CrossTenantFixtures> {
  // TODO: Implement when application schema is available.
  // Steps:
  // 1. Create or find org "test-tenant-a" and "test-tenant-b"
  // 2. Create or find a user in each org
  // 3. Sign in both users to get JWT session tokens
  // 4. Seed one resource of each type (booking, conversation, etc.) per tenant
  // 5. Return tokens and resource IDs
  throw new Error(
    "Cross-tenant fixtures not yet implemented — " +
      "requires application schema (bookings, conversations, etc.). " +
      "See docs/security/cross-tenant-probe.md for implementation guidance.",
  );
}

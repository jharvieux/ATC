// #1585 — Request-scoped dedup of the `users` membership SELECT.
//
// tenantContextFromRequest (factories.ts) and assertPermission both look up the
// caller's `users` row for the resolved tenant, one immediately after the
// other, in the same request. That was two identical round-trips. factories.ts
// now selects the full row and stashes it here; assertPermission reads it back.
//
// WHY A WeakMap KEYED BY THE Request OBJECT:
//
// The key is the Request instance itself, so an entry is reachable only while
// the request that created it is alive, and is unreachable (GC-able) the moment
// it isn't. That gives request scoping as a structural property rather than a
// TTL to tune or a key-collision to reason about. There is deliberately NO
// cross-request cache here: a `users` row carries status and role — the inputs
// to every RBAC decision — so serving a stale copy would mean honouring a
// revoked membership or a downgraded role. Membership is re-read from the DB on
// every new request, exactly as before.
//
// FAIL-CLOSED (D-091 #2): a miss returns undefined and the caller performs its
// own authoritative SELECT. This cache can only ever remove a duplicate query
// within one request — it can never be the reason a caller is let through.
//
// The cached row is still the product of an RLS-scoped query under the user's
// own JWT, filtered by both auth_user_id AND tenant_id (D-091 #4 — both layers
// of tenant isolation intact); the entry is keyed by tenant so a context for a
// different tenant can never read it.

import "server-only";

import type { UserRole } from "./permission-grants";

export interface MembershipRow {
  id: string;
  auth_user_id: string;
  tenant_id: string;
  status: string;
  role: UserRole;
}

interface CacheEntry {
  authUserId: string;
  tenantId: string;
  row: MembershipRow;
}

const cache = new WeakMap<Request, CacheEntry>();

export function cacheMembership(
  req: Request,
  authUserId: string,
  tenantId: string,
  row: MembershipRow,
): void {
  cache.set(req, { authUserId, tenantId, row });
}

/**
 * Returns the membership row already fetched for this exact request AND this
 * exact (authUserId, tenantId) pair — or undefined, which obliges the caller to
 * query. The identity check is what keeps this honest: an entry written for one
 * principal/tenant is never handed to a lookup for another.
 */
export function getCachedMembership(
  req: Request,
  authUserId: string,
  tenantId: string,
): MembershipRow | undefined {
  const entry = cache.get(req);
  if (!entry) return undefined;
  if (entry.authUserId !== authUserId || entry.tenantId !== tenantId) return undefined;
  return entry.row;
}

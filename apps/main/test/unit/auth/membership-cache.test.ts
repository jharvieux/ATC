// #1585 — the request-scoped membership cache.
//
// WHY THESE TESTS MATTER: this cache holds `status` and `role` — the inputs to
// every RBAC decision in the app. A cache that served the wrong row would be an
// authorization bug, not a performance bug: honouring a revoked membership,
// leaking one tenant's role into another tenant's request, or handing user A's
// permissions to user B. The tests below pin the three properties that make the
// cache safe — keyed by request, keyed by principal, keyed by tenant — so that
// widening any of them (e.g. "let's make it a module-level Map with a TTL to
// get cross-request hits") fails loudly here.

import { describe, it, expect } from "vitest";
import { cacheMembership, getCachedMembership, type MembershipRow } from "@/lib/auth/membership-cache";

const TENANT_A = "tenant-aaaa";
const TENANT_B = "tenant-bbbb";
const USER_A = "auth-user-aaaa";
const USER_B = "auth-user-bbbb";

function row(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    id: "public-user-1",
    auth_user_id: USER_A,
    tenant_id: TENANT_A,
    status: "active",
    role: "tenant_owner",
    ...overrides,
  };
}

const req = () => new Request("https://tenant.example.com/api/thing");

describe("membership cache", () => {
  it("returns the row cached for the same request, principal and tenant", () => {
    const r = req();
    const m = row();
    cacheMembership(r, USER_A, TENANT_A, m);
    expect(getCachedMembership(r, USER_A, TENANT_A)).toBe(m);
  });

  it("misses when nothing was cached for the request", () => {
    expect(getCachedMembership(req(), USER_A, TENANT_A)).toBeUndefined();
  });

  // Request-scoping is the whole safety story: entries must never outlive the
  // request that produced them. A cross-request hit would mean a user's role
  // could be revoked in the DB and still honoured on later requests.
  it("never serves one request's entry to another request", () => {
    const first = req();
    cacheMembership(first, USER_A, TENANT_A, row());
    expect(getCachedMembership(req(), USER_A, TENANT_A)).toBeUndefined();
  });

  // Identity confusion: an entry written for user A must never answer a lookup
  // for user B, which would hand B the role of A.
  it("never serves one principal's row to another principal", () => {
    const r = req();
    cacheMembership(r, USER_A, TENANT_A, row());
    expect(getCachedMembership(r, USER_B, TENANT_A)).toBeUndefined();
  });

  // Tenant isolation (D-091 #4) at the cache layer: a row fetched for tenant A
  // must never satisfy a tenant-B lookup, even for the same user — a user can
  // legitimately hold different roles in different tenants.
  it("never serves one tenant's row to another tenant's lookup", () => {
    const r = req();
    cacheMembership(r, USER_A, TENANT_A, row());
    expect(getCachedMembership(r, USER_A, TENANT_B)).toBeUndefined();
  });
});

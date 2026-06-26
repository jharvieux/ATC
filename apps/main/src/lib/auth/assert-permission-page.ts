// Page-safe assertPermission for Next.js App Router server components.
//
// assertPermission() (assert-permission.ts) takes a Request object, which
// does not exist in a server component render context. This helper bridges
// that gap using the same building blocks:
//
//   1. getCachedUser()      — verified Supabase auth user (shared with layout)
//   2. headers()            — next/headers read of x-resolved-tenant-id
//   3. getTenantRole()      — DB lookup: user's role in the resolved tenant
//   4. isPermitted()        — RBAC matrix check (permission-grants.ts)
//
// On failure (no session, no membership, or RBAC denial) the helper calls
// redirect("/") so the page never renders. The caller gets back the role
// so it can use it for further rendering decisions without a second DB call.
//
// React.cache memoizes the result per request so a page that calls
// assertPermissionPage and a layout that calls getCachedUser share one
// getUser() round-trip (getCachedUser is already cached; getTenantRole
// here is memoised separately per (tenantId) by the cache below).

import { cache as reactCache } from "react";
import { headers } from "next/headers";
import { getCachedUser } from "@/lib/auth/get-cached-user";
import { getTenantRole } from "@/lib/auth/resolve-post-login";
import { isPermitted, type UserRole } from "@/lib/auth/permission-grants";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

// Same React.cache guard pattern as get-cached-user.ts and assert-platform-admin.ts.
type CacheFn = <T extends (...a: never[]) => unknown>(fn: T) => T;
const _cache: CacheFn = (() => {
  if (typeof reactCache === "function") return reactCache as CacheFn;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "assert-permission-page: react.cache missing in production — " +
        "page auth would double DB lookups.",
    );
  }
  return (fn) => fn;
})();

/**
 * Request-scoped memoised tenant-role lookup for server component pages.
 * Returns the user's role in the middleware-resolved tenant, or null when:
 *   - no valid session
 *   - no active membership in the resolved tenant
 *   - tenant_id header is absent or is the "platform" sentinel
 *
 * Callers that need role-dependent rendering can receive and inspect it.
 * The memo key is just the function itself (one role per request).
 */
export const getCachedTenantRole = _cache(async (): Promise<UserRole | null> => {
  const { isAuthenticated, user } = await getCachedUser();
  if (!isAuthenticated || !user) return null;

  const incoming = await headers();
  const tenantId = incoming.get(RESOLVED_TENANT_ID_HEADER);
  if (!tenantId || tenantId === "platform") return null;

  try {
    return await getTenantRole(user.id, tenantId);
  } catch (err) {
    console.error("[assert-permission-page] getTenantRole failed:", err);
    return null;
  }
});

/**
 * Page-level permission gate for server components.
 *
 * Checks that the caller is authenticated, holds an active membership in the
 * resolved tenant, and that their role is permitted for (resource, action).
 * On any failure, calls redirect("/") — the page never renders.
 *
 * Returns the caller's role so pages can use it for further rendering
 * decisions without an additional DB call.
 *
 * Usage:
 *   const role = await assertPermissionPage({ resource: "groups", action: "list" });
 */
export async function assertPermissionPage(opts: {
  resource: string;
  action: string;
}): Promise<UserRole> {
  // next/navigation is server-only; import inline to avoid pulling it into
  // edge/test environments where it doesn't exist (mirrors the pattern in
  // assert-platform-admin.ts assertPlatformRolePage).
  const { redirect } = await import("next/navigation");

  const role = await getCachedTenantRole();
  if (!role || !isPermitted(role, opts.resource, opts.action)) {
    redirect("/");
    // redirect() throws internally in Next.js (NEXT_REDIRECT) — this line
    // is unreachable but satisfies TypeScript's control-flow analysis.
    throw new Error("unreachable");
  }
  return role;
}

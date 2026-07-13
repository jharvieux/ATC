// §17.7 — Sensitive-operations route allowlist.
//
// Routes in this set require session age ≤ 4 hours. If the user's session
// was authenticated more than 4 hours ago, the handler should redirect to
// /auth/reauth?return=<original_path> before processing the request.
//
// Matched against the request pathname using startsWith.

const SENSITIVE_ROUTE_PREFIXES: ReadonlySet<string> = new Set([
  "/api/commissions",        // commission overrides
  "/api/onboarding/ica",     // ICA acceptance
  "/api/user/data",          // CCPA delete/export
  "/api/admin/tenants",      // admin role changes and review actions
  "/api/tenant/billing",     // billing management
]);

export function isSensitiveRoute(pathname: string): boolean {
  for (const prefix of SENSITIVE_ROUTE_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

// Max session age in milliseconds for sensitive operations (4 hours).
export const SENSITIVE_SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;

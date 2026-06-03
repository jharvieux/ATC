// Allowlist for check-page-service-role.mjs and page-service-role.test.ts.
// Single source of truth — import this instead of duplicating the Set.
//
// Every entry must document WHY the page is safe without an admin credential.

export const ALLOWLIST = new Set([
  // Token-gated pages — the URL token IS the credential; the page resolves
  // notFound() for invalid/expired tokens (checked in the query, no row → 404).
  "companion/[token]/page.tsx",
  "i/[token]/page.tsx",
  "q/[token]/page.tsx",
  // Public legal content — reads only published legal_documents rows; no
  // tenant or user data is accessible via this query.
  "legal/ai-disclaimer/page.tsx",
]);

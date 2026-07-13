// Canonical tenant lifecycle status list — mirrors the DB CHECK constraint
// on `tenants.status`. Previously duplicated as an inline subset in
// resolve-post-login.ts and an inline full union in billing/payment-state.ts
// (#1610) — both now import from here.

const TENANT_LIFECYCLE_STATUSES = [
  "onboarding",
  "pending_review",
  "active",
  "suspended",
  "terminated",
] as const;

export type TenantLifecycleStatus = (typeof TENANT_LIFECYCLE_STATUSES)[number];

/** Statuses that route normally (onboarding flow + crm). `suspended` and
 *  `terminated` tenants fall through to /chat (#666). Typed as
 *  ReadonlySet<string> (not TenantLifecycleStatus) because callers check
 *  it against the loosely-typed PostgREST `status` column. */
export const ROUTEABLE_TENANT_STATUSES: ReadonlySet<string> = new Set<string>([
  "onboarding",
  "pending_review",
  "active",
]);

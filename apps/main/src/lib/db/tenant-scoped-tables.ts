// Tables NOT in this set are NOT auto-filtered by `tenantClient`.
//
// Adding a new tenant-scoped table requires:
//   1. Adding it here, AND
//   2. Adding the four RLS policies per spec §5.1.2 (SELECT/INSERT/UPDATE/DELETE).
//
// Both happen in the same PR. The migration-lint gate (§30.8) blocks the
// table-creation migration if RLS coverage is missing; the unit tests
// here catch the case where a developer adds RLS but forgets the set entry,
// which would let a query escape the proxy's tenant_id filter.
//
// Tables listed here that don't exist yet (most of them, until §5.3 lands)
// are intentional — the central list is easier to maintain than scattered
// per-table allowlists. The proxy's .has() check is O(1) regardless.

export const TENANT_SCOPED_TABLES: ReadonlySet<string> = new Set([
  "users",
  "conversations",
  "messages",
  "bookings",
  "commissions",
  "subcontractors",
  "payout_balances",
  "payout_records",
  "stripe_webhook_events",
  "tenant_persona_overrides",
  "escalation_topics",
]);

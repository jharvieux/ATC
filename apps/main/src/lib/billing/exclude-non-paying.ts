// §15.16 — Helpers for crons + handlers to skip non-paying tenants past
// the 7-day grace window. Built on top of derivePaymentState
// (lib/billing/payment-state.ts) so the gate logic stays in one place.
//
// Two shapes:
//   excludeNonPayingPastGrace(tenants) — bulk filter for cron loops that
//     SELECT tenants and iterate. Returns the same array minus past-grace
//     tenants. Within-grace tenants are kept (the §15.16 contract — grace
//     period preserves automated features).
//   assertTenantStillPaying(tenant)    — single-tenant check for event-
//     driven crons that operate on one tenant_id at a time. Returns ok=true
//     for paying + within-grace; ok=false + reason for past-grace.
//
// Callers MUST include subscription_status + non_paying_since + status in
// their SELECT, or the derivation falls back to the lenient backfill path
// (treats unknown subscription_status as within-grace).

import { derivePaymentState, type TenantPaymentFields } from "./payment-state";

/** Rows must carry the three fields derivePaymentState reads. */
type WithPaymentFields = TenantPaymentFields & { id?: string };

/**
 * Filter a list of tenants, dropping any that are non-paying past grace.
 * Returns the survivors. Callers typically log the skipped count for
 * observability — pass `onSkip` if you want to be told who was filtered.
 */
export function excludeNonPayingPastGrace<T extends WithPaymentFields>(
  tenants: readonly T[],
  onSkip?: (tenant: T, daysSinceNonPaying: number) => void,
): T[] {
  const out: T[] = [];
  for (const t of tenants) {
    const state = derivePaymentState(t);
    if (state.isPastGrace) {
      if (onSkip) onSkip(t, state.daysSinceNonPaying);
      continue;
    }
    out.push(t);
  }
  return out;
}

export interface PaymentAssertion {
  ok: boolean;
  reason?: "past_grace";
  days_since_non_paying?: number;
}

/**
 * Returns ok=true for paying + within-grace tenants; ok=false (with
 * reason='past_grace' and days_since_non_paying) for past-grace. Caller
 * decides whether to skip silently, log, or surface to the user.
 */
export function assertTenantStillPaying(t: TenantPaymentFields): PaymentAssertion {
  const state = derivePaymentState(t);
  if (state.isPastGrace) {
    return {
      ok: false,
      reason: "past_grace",
      days_since_non_paying: state.daysSinceNonPaying,
    };
  }
  return { ok: true };
}

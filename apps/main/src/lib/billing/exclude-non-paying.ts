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

import type { SupabaseClient } from "@supabase/supabase-js";
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

export type PaymentAssertionReason = "past_grace" | "tenant_not_found";

export interface PaymentAssertion {
  ok: boolean;
  reason?: PaymentAssertionReason;
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

/**
 * Fetch-and-check helper for event-driven Inngest handlers that have a
 * tenant_id from event.data but no tenant row in scope. Returns the same
 * shape as assertTenantStillPaying — the 'tenant_not_found' reason fires
 * when the tenant was hard-deleted between event emit and handler firing.
 *
 * Fails open on DB errors — better to occasionally process a past-grace
 * tenant than to silently drop legitimate events on a transient blip.
 */
export async function assertTenantStillPayingById(
  db: SupabaseClient,
  tenant_id: string,
): Promise<PaymentAssertion> {
  const { data, error } = await db
    .from("tenants")
    .select("status, subscription_status, non_paying_since")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) {
    console.warn("[assertTenantStillPayingById] DB error — failing open", { tenant_id, error: error.message });
    return { ok: true };
  }
  if (!data) {
    return { ok: false, reason: "tenant_not_found" };
  }
  return assertTenantStillPaying(data as TenantPaymentFields);
}

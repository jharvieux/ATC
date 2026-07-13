// §15.16 — Derives the payment gate state from the columns set by the
// Stripe webhook handler. Single source of truth for both the middleware
// gate (lib/billing/middleware-gate.ts) and the cron-loop filter
// (lib/billing/exclude-non-paying-past-grace.ts) so they never disagree.
//
// "Paying"  = subscription is active or in a free trial.
// "Non-paying" = anything else (past_due, unpaid, canceled, incomplete,
//               incomplete_expired, paused). NULL is also treated as
//               non-paying — a tenant with no subscription_status set
//               has never completed checkout, so should not have access
//               to paid features.
//
// Grace period: tenants stay in the "within grace" state for 7 days
// after first entering a non-paying state. Past that, "past grace" —
// middleware redirects to billing, crons skip them.

import type { TenantLifecycleStatus } from "@/lib/tenants/lifecycle";

export const NON_PAYING_GRACE_DAYS = 7;

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

const PAYING_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  "active",
  "trialing",
]);

export interface TenantPaymentFields {
  // Loose-typed (string | null) so callers selecting the column with
  // a generic Supabase query don't need to cast — the CHECK constraint
  // in the migration enforces the values at the database edge.
  subscription_status: SubscriptionStatus | string | null;
  non_paying_since: string | null;
  // Onboarding tenants haven't paid yet by design; they shouldn't get
  // gated out of the onboarding flow.
  status: TenantLifecycleStatus | string;
  // #699 — ATC-owned tenants bypass the payment gate. The platform
  // doesn't bill itself. Optional in the type so callers that don't
  // select the column (the cron loops written before this flag landed)
  // still typecheck — at runtime the DB column is NOT NULL DEFAULT
  // FALSE, so any row actually fetched has a concrete value. `undefined`
  // is treated as `false` in derivePaymentState.
  is_platform_internal?: boolean;
}

export interface PaymentState {
  // True when the tenant has an active/trialing subscription OR is still
  // in the onboarding/pending_review flow (which has its own checkout step).
  isPaying: boolean;
  // True when the tenant is non-paying AND has been so for longer than
  // the grace period. Pages should redirect to billing; crons should skip.
  isPastGrace: boolean;
  // True when non-paying but inside the grace window. Pages should still
  // work but show a "payment required" banner.
  isWithinGrace: boolean;
  // Days since first observed in a non-paying state. 0 if currently paying.
  // Useful for telemetry / debug output.
  daysSinceNonPaying: number;
}

export function derivePaymentState(t: TenantPaymentFields, now: Date = new Date()): PaymentState {
  // #699 — ATC-owned tenants (is_platform_internal=TRUE) bypass the
  // payment gate. Checked FIRST so the exemption applies regardless of
  // status — internal tenants should run as `active` for branding/RLS
  // semantics without ever hitting billing.
  if (t.is_platform_internal === true) {
    return { isPaying: true, isPastGrace: false, isWithinGrace: false, daysSinceNonPaying: 0 };
  }

  // Onboarding / pending_review tenants are pre-payment by design; the
  // payment gate doesn't apply yet (the onboarding flow has its own
  // checkout step that drives them to active).
  //
  // NOTE: this exemption has no time bound today — a tenant stuck in
  // onboarding could use paid features indefinitely. Tracked in #700.
  if (t.status === "onboarding" || t.status === "pending_review") {
    return { isPaying: true, isPastGrace: false, isWithinGrace: false, daysSinceNonPaying: 0 };
  }

  // suspended / terminated tenants are out independently of payment state.
  // Treat as past-grace so callers gate them too.
  if (t.status === "suspended" || t.status === "terminated") {
    return { isPaying: false, isPastGrace: true, isWithinGrace: false, daysSinceNonPaying: 0 };
  }

  const isPaying =
    t.subscription_status !== null && PAYING_STATUSES.has(t.subscription_status as SubscriptionStatus);
  if (isPaying) {
    return { isPaying: true, isPastGrace: false, isWithinGrace: false, daysSinceNonPaying: 0 };
  }

  // Non-paying. Compute grace.
  if (!t.non_paying_since) {
    // Webhook hasn't backfilled this column yet (tenant became non-paying
    // before this PR shipped). Be lenient — treat as within-grace until the
    // next state change writes the timestamp.
    return { isPaying: false, isPastGrace: false, isWithinGrace: true, daysSinceNonPaying: 0 };
  }

  const days = (now.getTime() - new Date(t.non_paying_since).getTime()) / (1000 * 60 * 60 * 24);
  if (days >= NON_PAYING_GRACE_DAYS) {
    return { isPaying: false, isPastGrace: true, isWithinGrace: false, daysSinceNonPaying: days };
  }
  return { isPaying: false, isPastGrace: false, isWithinGrace: true, daysSinceNonPaying: days };
}

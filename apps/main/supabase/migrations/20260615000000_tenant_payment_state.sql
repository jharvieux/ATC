-- §15.16 — Per-tenant Stripe subscription state, tracked off the
-- customer.subscription.* and invoice.payment_* webhooks. Drives the
-- payment gate in middleware + cron-loop filter, both of which need a
-- single source of truth that doesn't require live Stripe API calls.
--
-- Why a column instead of always-reading-Stripe:
--   1. Every chat turn and every cron iteration would otherwise need a
--      Stripe API call → rate-limit risk + 200-400ms added latency.
--   2. Webhook delivery has at-least-once semantics with bounded delay
--      (Stripe retries ~3 days). For our purposes that's "real-time
--      enough" — we accept up to a few minutes of stale state.
--
-- The two columns:
--   subscription_status — Stripe's verbatim status enum. NULL until the
--                         first customer.subscription.* webhook arrives.
--                         CHECK constraint enumerates the Stripe values
--                         we know about; new ones make the constraint
--                         fail loudly (better than silent acceptance).
--   non_paying_since    — first observed timestamp the tenant entered a
--                         non-paying state (past_due / unpaid / canceled
--                         / incomplete / incomplete_expired). Cleared on
--                         return to active/trialing. Drives the 7-day
--                         grace clock.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS subscription_status TEXT
    CHECK (subscription_status IS NULL OR subscription_status IN (
      'active',
      'trialing',
      'past_due',
      'unpaid',
      'canceled',
      'incomplete',
      'incomplete_expired',
      'paused'
    )),
  ADD COLUMN IF NOT EXISTS non_paying_since TIMESTAMPTZ;

-- Partial index for the cron-loop filter: "give me tenants past their
-- grace period." 7-day cutoff is the application-layer constant; the
-- index is just on non_paying_since which the query filters on.
CREATE INDEX IF NOT EXISTS tenants_non_paying_since_idx
  ON public.tenants (non_paying_since)
  WHERE non_paying_since IS NOT NULL;

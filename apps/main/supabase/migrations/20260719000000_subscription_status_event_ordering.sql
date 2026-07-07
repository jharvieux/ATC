-- #1583 — Stripe subscription-state webhooks (customer.subscription.*,
-- invoice.payment_succeeded, invoice.payment_failed) are at-least-once and
-- unordered. The handler's error path clears the dedup row, so an event can
-- be re-delivered hours/days later after newer events already advanced the
-- tenant's state — a stale `past_due` re-delivery can gate an already-paying
-- tenant. This column records the Stripe event envelope `created` timestamp
-- of the last-applied subscription-status write per tenant; the webhook
-- handler compares an incoming event's `created` against it and discards
-- (does not apply) events that are not newer.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS subscription_status_event_at TIMESTAMPTZ;

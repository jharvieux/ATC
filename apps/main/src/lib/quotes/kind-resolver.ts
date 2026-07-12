// §21.10.1 — Resolve a quote's effective price_kind.
//
// CONFIRMED iff ALL of:
//   1. quote.priced_at is within the last 15 minutes
//   2. the host adapter declares supports_price_lock = true
//   3. the response included a price_lock_token AND
//      price_lock_expires_at is in the future
//
// Otherwise ESTIMATE.
//
// #1742 — the 15-minute freshness window (condition 1) means this must be
// evaluated ONCE, at the moment a quote is priced (priced_at gets stamped),
// and the result persisted to quotes.price_kind — NOT recomputed on every
// later PDF render/download. #1699 made the persisted column authoritative
// specifically so a render doesn't re-derive and potentially disagree with
// what the customer already accepted; re-running this resolver at render
// time would silently flip a legitimately CONFIRMED quote back to ESTIMATE
// the moment priced_at ages past 15 minutes, even with a still-valid lock.
// The persisted value is read (not re-derived) by the PDF renderer and the
// /api/quotes/:id/accept handler; the booking-submit handler uses this
// resolver directly to decide its own flow path.
//
// Today NO write path ever supplies a price_lock_token (no host-adapter
// price-lock integration exists for quotes yet — see NO_HOST_INTEGRATION_ADAPTER
// below), so this deterministically resolves to 'estimate' everywhere it's
// called. That's the correct, spec-mandated default (§21.10.1: "Most host
// adapters at launch will NOT expose price-lock — so default is estimate").
// CONFIRMED becomes reachable the day a real price-lock call is wired in.

import type { HostAgencyClient, HostCapabilities } from "@atc/shared-types";

export interface QuoteForKind {
  priced_at: string | null;
  price_lock_token: string | null;
  price_lock_expires_at: string | null;
}

export type QuoteKind = "estimate" | "confirmed";

// Stand-in for write paths (manual quote-pricing entry today) that have no
// real host-adapter selection available and can never supply a lock token
// anyway — supports_price_lock's value doesn't change the outcome for those
// callers, but declaring it false is the honest representation.
const NO_LOCK_CAPABILITIES: HostCapabilities = {
  supports_inventory_search: false,
  supports_real_time_booking: false,
  supports_modification: false,
  supports_cancellation: false,
  supports_commission_api: false,
  supports_price_lock: false,
  booking_types: [],
  cruise_lines_supported: [],
  commission_currency: "USD",
  payment_lag_days_typical: 0,
};
export const NO_HOST_INTEGRATION_ADAPTER: Pick<HostAgencyClient, "capabilities"> = {
  capabilities: NO_LOCK_CAPABILITIES,
};

const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;

export function resolveQuoteKind(
  quote: QuoteForKind,
  adapter: Pick<HostAgencyClient, "capabilities">,
  now: Date = new Date(),
): QuoteKind {
  if (!quote.priced_at) return "estimate";
  const priced = new Date(quote.priced_at).getTime();
  if (Number.isNaN(priced)) return "estimate";
  if (now.getTime() - priced > FRESHNESS_WINDOW_MS) return "estimate";

  if (!adapter.capabilities.supports_price_lock) return "estimate";
  if (!quote.price_lock_token) return "estimate";
  if (!quote.price_lock_expires_at) return "estimate";

  const lockExpiry = new Date(quote.price_lock_expires_at).getTime();
  if (Number.isNaN(lockExpiry)) return "estimate";
  if (lockExpiry < now.getTime()) return "estimate";

  return "confirmed";
}

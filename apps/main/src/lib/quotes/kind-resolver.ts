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
// The persisted price_kind column on quotes records the kind at PDF render
// time. This resolver is used by the booking-submit handler to decide the
// flow path; the persisted value is used by the PDF renderer and the
// /api/quotes/:id/accept handler.

import type { HostAgencyClient } from "@atc/shared-types";

export interface QuoteForKind {
  priced_at: string | null;
  price_lock_token: string | null;
  price_lock_expires_at: string | null;
}

export type QuoteKind = "estimate" | "confirmed";

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

// §21.10.1 — Quote kind resolver tests.
// Why these matter: a quote misclassified as CONFIRMED commits the platform
// to honor a stale price. Misclassified as ESTIMATE puts a valid lock at
// risk of variance-pause that wasn't needed.

import { describe, it, expect } from "vitest";
import { resolveQuoteKind, NO_HOST_INTEGRATION_ADAPTER } from "@/lib/quotes/kind-resolver";

const lockSupporting = {
  capabilities: {
    supports_inventory_search: true,
    supports_real_time_booking: true,
    supports_modification: true,
    supports_cancellation: true,
    supports_commission_api: true,
    supports_price_lock: true,
    booking_types: [],
    cruise_lines_supported: [],
    commission_currency: "USD",
    payment_lag_days_typical: 7,
  },
};

const lockUnsupported = {
  capabilities: { ...lockSupporting.capabilities, supports_price_lock: false },
};

describe("resolveQuoteKind — §21.10.1", () => {
  it("returns 'confirmed' for a fresh quote with valid lock + supporting adapter", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    const quote = {
      priced_at: new Date(now.getTime() - 14 * 60 * 1000).toISOString(), // 14 min ago
      price_lock_token: "lock-1",
      price_lock_expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };
    expect(resolveQuoteKind(quote, lockSupporting, now)).toBe("confirmed");
  });

  it("returns 'estimate' for a 16-min-old quote even with lock + supporting adapter", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    const quote = {
      priced_at: new Date(now.getTime() - 16 * 60 * 1000).toISOString(),
      price_lock_token: "lock-1",
      price_lock_expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };
    expect(resolveQuoteKind(quote, lockSupporting, now)).toBe("estimate");
  });

  it("returns 'estimate' when adapter does not support price lock", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    const quote = {
      priced_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      price_lock_token: "lock-1",
      price_lock_expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };
    expect(resolveQuoteKind(quote, lockUnsupported, now)).toBe("estimate");
  });

  it("returns 'estimate' when fresh but no lock token returned", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    const quote = {
      priced_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      price_lock_token: null,
      price_lock_expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };
    expect(resolveQuoteKind(quote, lockSupporting, now)).toBe("estimate");
  });

  it("returns 'estimate' when the lock has expired", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    const quote = {
      priced_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      price_lock_token: "lock-1",
      price_lock_expires_at: new Date(now.getTime() - 60 * 1000).toISOString(),
    };
    expect(resolveQuoteKind(quote, lockSupporting, now)).toBe("estimate");
  });

  it("returns 'estimate' when priced_at is missing", () => {
    expect(
      resolveQuoteKind(
        { priced_at: null, price_lock_token: null, price_lock_expires_at: null },
        lockSupporting,
      ),
    ).toBe("estimate");
  });

  // #1742: manual pricing-entry write paths (e.g. POST /api/quotes) have no
  // real host adapter to select and can never supply a lock token through
  // that API anyway. NO_HOST_INTEGRATION_ADAPTER stands in for those callers
  // — pin that it deterministically resolves to 'estimate' even when freshly
  // priced, so a future caller can't accidentally wire it somewhere that
  // expects it to ever produce 'confirmed'.
  it("NO_HOST_INTEGRATION_ADAPTER always resolves 'estimate', even when freshly priced", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    expect(
      resolveQuoteKind(
        { priced_at: now.toISOString(), price_lock_token: null, price_lock_expires_at: null },
        NO_HOST_INTEGRATION_ADAPTER,
        now,
      ),
    ).toBe("estimate");
  });
});

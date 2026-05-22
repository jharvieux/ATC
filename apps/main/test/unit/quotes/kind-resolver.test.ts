// §21.10.1 — Quote kind resolver tests.
// Why these matter: a quote misclassified as CONFIRMED commits the platform
// to honor a stale price. Misclassified as ESTIMATE puts a valid lock at
// risk of variance-pause that wasn't needed.

import { describe, it, expect } from "vitest";
import { resolveQuoteKind } from "@/lib/quotes/kind-resolver";

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
});

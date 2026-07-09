// Unit tests for money utility module — §14.0.4
//
// Property under test: NO sub-cent drift when split is computed via
//   multiplyRate + subtractFee (spec §14.3 subtract-not-multiply guarantee).
//
// Covers: rounding edge cases, NegativeMoneyError, CurrencyMismatchError,
// assertSafeStripeAmount, toRate range guard.

import { describe, it, expect } from "vitest";
import {
  toCents,
  dollarsToCents,
  fromCents,
  formatCents,
  multiplyRate,
  subtractFee,
  assertSameCurrency,
  assertSafeStripeAmount,
  toRate,
  NegativeMoneyError,
  CurrencyMismatchError,
  type Cents,
  type MoneyValue,
} from "@/lib/money";

// ── toCents ─────────────────────────────────────────────────────────────────

describe("toCents (§14.0.3 half-away-from-zero)", () => {
  it("rounds .5 up (half-away-from-zero)", () => {
    expect(toCents(0.5)).toBe(1n);
    expect(toCents(1.5)).toBe(2n);
    expect(toCents(99.995)).toBe(100n); // $0.99995 → 100 cents
  });

  it("rounds .4 down", () => {
    expect(toCents(0.4)).toBe(0n);
    expect(toCents(1.4)).toBe(1n);
  });

  it("handles exact integer values without drift", () => {
    expect(toCents(500)).toBe(500n);
    expect(toCents(0)).toBe(0n);
  });

  it("accepts numeric string input", () => {
    expect(toCents("99.99")).toBe(100n); // 99.99 cents → 100n cents
    expect(toCents("0.01")).toBe(0n);    // 0.01 cents → 0n cents (rounds down)
    expect(toCents("0.50")).toBe(1n);    // 0.5 cents → 1n (half-up)
  });
});

// ── dollarsToCents ───────────────────────────────────────────────────────────

describe("dollarsToCents (dollar amount → integer cents)", () => {
  it("multiplies dollars by 100 (distinct from toCents, which rounds cents)", () => {
    expect(dollarsToCents("25.00")).toBe(2500n);
    expect(dollarsToCents(25)).toBe(2500n);
    expect(dollarsToCents("0.99")).toBe(99n);
    expect(dollarsToCents("1234.56")).toBe(123456n);
  });

  it("is exact on 2-decimal values that float ×100 would corrupt", () => {
    // 25.99 * 100 === 2598.9999999999995 in float; Big keeps it exact.
    expect(dollarsToCents("25.99")).toBe(2599n);
    expect(dollarsToCents("0.29")).toBe(29n);
  });

  it("half-away-from-zero on sub-cent dollar inputs", () => {
    expect(dollarsToCents("0.005")).toBe(1n); // $0.005 → 0.5c → 1c
    expect(dollarsToCents("0.004")).toBe(0n);
  });
});

// ── fromCents ────────────────────────────────────────────────────────────────

describe("fromCents (display only)", () => {
  it("renders cents as decimal dollar string", () => {
    expect(fromCents(0n)).toBe("0.00");
    expect(fromCents(100n)).toBe("1.00");
    expect(fromCents(72500n)).toBe("725.00");
    expect(fromCents(500000n)).toBe("5000.00");
  });

  it("preserves two decimal places", () => {
    expect(fromCents(1n)).toBe("0.01");
    expect(fromCents(10n)).toBe("0.10");
  });
});

// ── formatCents ──────────────────────────────────────────────────────────────

describe("formatCents (canonical display formatter with currency)", () => {
  it("formats cents with default USD currency symbol", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(72500)).toBe("$725.00");
    expect(formatCents(2500000)).toBe("$25,000.00");
  });

  it("formats with thousands separators", () => {
    expect(formatCents(1234567)).toBe("$12,345.67");
  });

  it("handles null and undefined as em-dash", () => {
    expect(formatCents(null)).toBe("—");
    expect(formatCents(undefined)).toBe("—");
  });

  it("formats with non-USD currency codes", () => {
    expect(formatCents(100, "EUR")).toBe("€1.00");
    expect(formatCents(100, "GBP")).toBe("£1.00");
  });

  it("scales zero-decimal currencies by their ISO-4217 exponent, not by 100 (#1658)", () => {
    // JPY/KRW/VND have no minor unit (exponent 0), so the stored integer IS the
    // major amount — dividing by 100 rendered it 100x too small. The exponent
    // now comes from Intl's own CLDR data, so scale and precision agree.
    expect(formatCents(100, "JPY")).toBe("¥100");
    expect(formatCents(100, "KRW")).toBe("₩100");
  });

  it("scales three-decimal currencies by 1000 (#1658)", () => {
    // KWD/BHD/OMR have exponent 3: 100 minor units = 0.100 major. Proves the
    // fix reads the real exponent rather than assuming 0 or 2. (Intl separates
    // the KWD code from the number with a non-breaking space, so normalize it.)
    const norm = (s: string) => s.replace(/[^\x21-\x7e]+/g, " ");
    expect(norm(formatCents(100, "KWD"))).toBe("KWD 0.100");
    expect(norm(formatCents(12345, "KWD"))).toBe("KWD 12.345");
  });

  it("falls back to 'CODE amount' for invalid currency codes", () => {
    expect(formatCents(100, "FAKE")).toBe("FAKE 1.00");
    expect(formatCents(100, "INVALID")).toBe("INVALID 1.00");
  });

  it("is case-insensitive on currency code input", () => {
    expect(formatCents(100, "eur")).toBe("€1.00");
    expect(formatCents(100, "usd")).toBe("$1.00");
  });
});

// ── multiplyRate ─────────────────────────────────────────────────────────────

describe("multiplyRate (§14.3 worked example)", () => {
  it("reproduces spec worked example: 500000 × 0.15 = 75000", () => {
    expect(multiplyRate(500000n, 0.15)).toBe(75000n);
  });

  it("reproduces spec worked example: 72500 × 0.20 = 14500", () => {
    expect(multiplyRate(72500n, 0.20)).toBe(14500n);
  });

  it("rounds half-away-from-zero: 33333 × 0.1000 = 3333 (3333.3 → 3333)", () => {
    // 33333 × 0.1 = 3333.3 → rounds to 3333
    expect(multiplyRate(33333n, 0.1)).toBe(3333n);
  });

  it("rounds half-away-from-zero: 33334 × 0.1000 = 3333 (3333.4 → 3333)", () => {
    expect(multiplyRate(33334n, 0.1)).toBe(3333n);
  });

  it("rounds half-away-from-zero: 33335 × 0.1000 = 3334 (3333.5 → 3334)", () => {
    expect(multiplyRate(33335n, 0.1)).toBe(3334n);
  });

  it("zero rate returns 0", () => {
    expect(multiplyRate(500000n, 0)).toBe(0n);
  });

  it("rate 1.0 returns original amount", () => {
    expect(multiplyRate(500000n, 1.0)).toBe(500000n);
  });
});

// ── subtractFee ──────────────────────────────────────────────────────────────

describe("subtractFee (§14.0.4 non-negative assertion)", () => {
  it("subtracts normally when result is positive", () => {
    expect(subtractFee(75000n as Cents, 2500n as Cents)).toBe(72500n);
  });

  it("allows zero result (exact equality)", () => {
    expect(subtractFee(2500n as Cents, 2500n as Cents)).toBe(0n);
  });

  it("throws NegativeMoneyError when fee exceeds amount", () => {
    expect(() => subtractFee(100n as Cents, 200n as Cents)).toThrow(NegativeMoneyError);
  });

  it("NegativeMoneyError carries minuend and subtrahend", () => {
    try {
      subtractFee(100n as Cents, 200n as Cents);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NegativeMoneyError);
      const err = e as NegativeMoneyError;
      expect(err.minuend_cents).toBe(100n);
      expect(err.subtrahend_cents).toBe(200n);
    }
  });
});

// ── §14.3 No sub-cent drift property ────────────────────────────────────────

describe("no sub-cent drift: platform_retained + subhost_payable === net_commission (§14.3)", () => {
  function computeSplit(
    faresCents: bigint,
    commissionRate: number,
    feesCents: bigint,
    splitRate: number,
  ) {
    const gross = multiplyRate(faresCents, commissionRate);
    const net = subtractFee(gross, feesCents);
    const retained = multiplyRate(net, splitRate);
    const payable = subtractFee(net, retained);
    return { net, retained, payable };
  }

  it("spec worked example: no drift (${500000, 0.15, 2500, 0.20})", () => {
    const { net, retained, payable } = computeSplit(500000n, 0.15, 2500n, 0.20);
    expect(net).toBe(72500n);
    expect(retained).toBe(14500n);
    expect(payable).toBe(58000n);
    expect(retained + payable).toBe(net); // key invariant
  });

  it("holds for an awkward rate (0.3333) that triggers rounding", () => {
    // net = 10000, rate = 0.3333 → 3333 retained, 6667 payable
    const { net, retained, payable } = computeSplit(200000n, 0.15, 5000n, 0.3333);
    expect(retained + payable).toBe(net);
  });

  it("holds at minimum tier (Starter 0.30 split)", () => {
    const { net, retained, payable } = computeSplit(100000n, 0.12, 1500n, 0.30);
    expect(retained + payable).toBe(net);
  });

  it("holds at Pro tier (0.25 split)", () => {
    const { net, retained, payable } = computeSplit(100000n, 0.12, 1500n, 0.25);
    expect(retained + payable).toBe(net);
  });

  it("holds at Agency tier (0.20 split)", () => {
    const { net, retained, payable } = computeSplit(100000n, 0.12, 1500n, 0.20);
    expect(retained + payable).toBe(net);
  });

  it("holds for BYO tier (0.15 split)", () => {
    const { net, retained, payable } = computeSplit(100000n, 0.12, 1500n, 0.15);
    expect(retained + payable).toBe(net);
  });
});

// ── assertSameCurrency ───────────────────────────────────────────────────────

describe("assertSameCurrency (§14.0.5 currency mixing guard)", () => {
  const usd: MoneyValue = { cents: 100n as Cents, currency: "USD" };
  const eur: MoneyValue = { cents: 100n as Cents, currency: "EUR" };

  it("passes silently when currencies match", () => {
    expect(() => assertSameCurrency(usd, { ...usd })).not.toThrow();
  });

  it("throws CurrencyMismatchError when currencies differ", () => {
    expect(() => assertSameCurrency(usd, eur)).toThrow(CurrencyMismatchError);
  });

  it("CurrencyMismatchError carries both currency codes", () => {
    try {
      assertSameCurrency(usd, eur);
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as CurrencyMismatchError;
      expect(err.a).toBe("USD");
      expect(err.b).toBe("EUR");
    }
  });
});

// ── assertSafeStripeAmount ───────────────────────────────────────────────────

describe("assertSafeStripeAmount (§14.7 MAX_SAFE_INTEGER guard)", () => {
  it("passes for realistic payout amounts", () => {
    expect(() => assertSafeStripeAmount(100000n)).not.toThrow(); // $1,000
    expect(() => assertSafeStripeAmount(BigInt(Number.MAX_SAFE_INTEGER))).not.toThrow();
  });

  it("throws when amount exceeds Number.MAX_SAFE_INTEGER", () => {
    expect(() =>
      assertSafeStripeAmount(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    ).toThrow(/assertSafeStripeAmount/);
  });
});

// ── toRate ───────────────────────────────────────────────────────────────────

describe("toRate (brand factory, range guard)", () => {
  it("accepts valid rates in [0, 1]", () => {
    expect(() => toRate(0)).not.toThrow();
    expect(() => toRate(0.15)).not.toThrow();
    expect(() => toRate(1.0)).not.toThrow();
  });

  it("throws RangeError for values below 0", () => {
    expect(() => toRate(-0.01)).toThrow(RangeError);
  });

  it("throws RangeError for values above 1", () => {
    expect(() => toRate(1.0001)).toThrow(RangeError);
  });
});

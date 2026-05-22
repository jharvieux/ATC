// §14.0.4 — Money utility module.
//
// ALL financial arithmetic must go through this module. Never do inline
// multiplication or division on _cents variables. The ESLint `atc/no-money-math`
// rule enforces this at code-review time.
//
// Library choice: big.js — arbitrary-precision, half-away-from-zero rounding
// by default (ROUND_HALF_UP), decimal arithmetic without floating-point error.
// MEMORY: big.js chosen over decimal.js for smaller bundle size and simpler API.
//
// Rounding: §14.0.3 mandates half-away-from-zero at exactly one conversion
// point (when converting from rate × fare to cents). This is big.js default.

import Big from "big.js";

// ── Brand types ──────────────────────────────────────────────────────────────

declare const _cents: unique symbol;
declare const _rate: unique symbol;

/** A monetary amount expressed as an integer number of cents. */
export type Cents = bigint & { readonly [_cents]: true };

/** A commission or split rate in decimal form (0.0000–1.0000). */
export type NumericRate = number & { readonly [_rate]: true };

export interface MoneyValue {
  cents: Cents;
  currency: string;
}

// ── Error types ──────────────────────────────────────────────────────────────

export class NegativeMoneyError extends Error {
  constructor(
    public readonly minuend_cents: bigint,
    public readonly subtrahend_cents: bigint,
  ) {
    super(
      `subtractFee: result would be negative (${minuend_cents} - ${subtrahend_cents} = ${minuend_cents - subtrahend_cents})`,
    );
    this.name = "NegativeMoneyError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(
    public readonly a: string,
    public readonly b: string,
  ) {
    super(`Currency mismatch: cannot combine ${a} and ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert a decimal amount (e.g., 99.995) to integer cents using
 * half-away-from-zero rounding. This is the ONLY place rounding may occur
 * in the commission pipeline.
 *
 * @param amount - a numeric value in dollar units (e.g., 99.995 = $99.995)
 */
export function toCents(amount: number | string): Cents {
  const big = new Big(amount);
  // DP=0, RM=1 (ROUND_HALF_UP) — half-away-from-zero per §14.0.3
  return BigInt(big.round(0, 1).toFixed(0)) as Cents;
}

/**
 * Convert cents back to a display value (decimal string).
 * FOR DISPLAY ONLY — do NOT chain arithmetic on the result.
 * @see §14.0.4 "fromCents is forbidden for arithmetic chaining"
 */
export function fromCents(cents: Cents | bigint): string {
  return new Big(cents.toString()).div(100).toFixed(2);
}

// ── Arithmetic ───────────────────────────────────────────────────────────────

/**
 * Multiply a cent amount by a decimal rate.
 * Uses Big.js to avoid floating-point errors, then rounds to nearest cent.
 *
 * @param cents - the base amount in cents
 * @param rate - a NumericRate (decimal, e.g. 0.1500 = 15%)
 */
export function multiplyRate(cents: Cents | bigint, rate: NumericRate | number): Cents {
  const result = new Big(cents.toString()).times(new Big(rate.toString()));
  return BigInt(result.round(0, 1).toFixed(0)) as Cents;
}

/**
 * Subtract a fee from an amount. Throws NegativeMoneyError if the result
 * would be negative — per §14.0 "the platform never owes negative money".
 */
export function subtractFee(cents: Cents | bigint, feeCents: Cents | bigint): Cents {
  const result = cents - feeCents;
  if (result < 0n) {
    throw new NegativeMoneyError(cents, feeCents);
  }
  return result as Cents;
}

/**
 * Assert two money values share the same currency.
 * At launch this checks both are 'USD'; the shape is forward-compatible.
 */
export function assertSameCurrency(a: MoneyValue, b: MoneyValue): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

/**
 * Safety guard before Stripe transfers per §14.7.
 * Stripe JavaScript SDK uses Number internally; amounts above Number.MAX_SAFE_INTEGER
 * may be silently corrupted.
 */
export function assertSafeStripeAmount(cents: Cents | bigint): void {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `assertSafeStripeAmount: amount ${cents} exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
        `Cannot safely pass to Stripe.`,
    );
  }
}

/**
 * Brand a raw NUMERIC(5,4) number as a NumericRate.
 * Use at system boundaries (DB reads, user input) to enter the type-safe rate world.
 */
export function toRate(raw: number): NumericRate {
  if (raw < 0 || raw > 1) {
    throw new RangeError(`Rate ${raw} is out of the valid [0, 1] range.`);
  }
  return raw as NumericRate;
}

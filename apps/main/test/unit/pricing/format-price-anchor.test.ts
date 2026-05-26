// §33.7 D-088 — price-anchor rounding tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPriceRoundingEnabled,
  roundPriceAnchor,
  formatPriceAnchorRange,
  formatPriceAnchorSingle,
} from "../../../src/lib/pricing/format-price-anchor";

const ORIG = process.env.AI_PRICE_ROUNDING_ENABLED;

beforeEach(() => {
  delete process.env.AI_PRICE_ROUNDING_ENABLED;
});

afterEach(() => {
  process.env.AI_PRICE_ROUNDING_ENABLED = ORIG;
});

describe("isPriceRoundingEnabled", () => {
  it("defaults to true when env unset", () => {
    expect(isPriceRoundingEnabled()).toBe(true);
  });

  it("respects AI_PRICE_ROUNDING_ENABLED=false", () => {
    process.env.AI_PRICE_ROUNDING_ENABLED = "false";
    expect(isPriceRoundingEnabled()).toBe(false);
  });

  it("treats any non-'false' value as enabled", () => {
    process.env.AI_PRICE_ROUNDING_ENABLED = "true";
    expect(isPriceRoundingEnabled()).toBe(true);
    process.env.AI_PRICE_ROUNDING_ENABLED = "1";
    expect(isPriceRoundingEnabled()).toBe(true);
  });
});

describe("roundPriceAnchor — +10% then round to nearest $100", () => {
  it("$1,200 → +10% = $1,320 → round to $1,300", () => {
    expect(roundPriceAnchor(1200)).toBe(1300);
  });

  it("$1,950 → +10% = $2,145 → round to $2,100", () => {
    expect(roundPriceAnchor(1950)).toBe(2100);
  });

  it("$2,001 → +10% = $2,201.10 → round to $2,200", () => {
    expect(roundPriceAnchor(2001)).toBe(2200);
  });

  it("$3,500 → +10% = $3,850 → round to $3,900", () => {
    expect(roundPriceAnchor(3500)).toBe(3900);
  });

  it("$4,000 → +10% = $4,400 (already round)", () => {
    expect(roundPriceAnchor(4000)).toBe(4400);
  });

  it("$0 returns 0 (no rounding)", () => {
    expect(roundPriceAnchor(0)).toBe(0);
  });

  it("negative input is passed through unchanged", () => {
    expect(roundPriceAnchor(-100)).toBe(-100);
  });

  it("NaN / Infinity pass through unchanged", () => {
    expect(roundPriceAnchor(NaN)).toBeNaN();
    expect(roundPriceAnchor(Infinity)).toBe(Infinity);
  });

  it("pass-through when AI_PRICE_ROUNDING_ENABLED=false", () => {
    process.env.AI_PRICE_ROUNDING_ENABLED = "false";
    expect(roundPriceAnchor(1234)).toBe(1234);
  });
});

describe("formatPriceAnchorRange", () => {
  it("formats $1,200-$3,500 as 'around $1,300 to $3,900'", () => {
    expect(formatPriceAnchorRange(1200, 3500)).toBe("around $1,300 to $3,900");
  });

  it("collapses to single when rounded lo == rounded hi", () => {
    // $980 → 1078 → 1100; $1020 → 1122 → 1100. Same after rounding.
    expect(formatPriceAnchorRange(980, 1020)).toBe("around $1,100");
  });

  it("inserts thousands separators", () => {
    expect(formatPriceAnchorRange(10000, 25000)).toBe("around $11,000 to $27,500");
  });

  it("still uses 'around' framing when rounding is disabled", () => {
    process.env.AI_PRICE_ROUNDING_ENABLED = "false";
    expect(formatPriceAnchorRange(1234, 5678)).toBe("around $1,234 to $5,678");
  });
});

describe("formatPriceAnchorSingle", () => {
  it("formats $1,200 as 'around $1,300'", () => {
    expect(formatPriceAnchorSingle(1200)).toBe("around $1,300");
  });

  it("formats with thousands separators", () => {
    expect(formatPriceAnchorSingle(10000)).toBe("around $11,000");
  });
});

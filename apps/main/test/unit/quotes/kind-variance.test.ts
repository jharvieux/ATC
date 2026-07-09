// §12.4 / §21.10.1 / #1699 — deriveKindAndVariance is the single source of
// truth both the downloadable-PDF path and the accept-time snapshot use to
// derive a quote's rendered kind + variance. These tests pin the authoritative
// rule so the two call sites can't silently drift apart again (the #1699 bug).

import { describe, it, expect, afterEach, vi } from "vitest";
import { deriveKindAndVariance } from "@/lib/quotes/kind-variance";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deriveKindAndVariance — kind derivation", () => {
  it("reads kind from the persisted price_kind column, not a price heuristic", () => {
    expect(deriveKindAndVariance({ price_kind: "confirmed", tenant_variance_cents: 100 }).kind).toBe("confirmed");
    expect(deriveKindAndVariance({ price_kind: "estimate", tenant_variance_cents: 100 }).kind).toBe("estimate");
  });

  it("defaults kind to 'estimate' when price_kind is null (matches the DB column default)", () => {
    expect(deriveKindAndVariance({ price_kind: null, tenant_variance_cents: 100 }).kind).toBe("estimate");
  });
});

describe("deriveKindAndVariance — variance derivation", () => {
  it("uses the tenant's configured variance for an estimate", () => {
    expect(deriveKindAndVariance({ price_kind: "estimate", tenant_variance_cents: 7500 }).variance_cents).toBe(7500);
  });

  it("forces variance to 0 for a confirmed quote regardless of tenant setting", () => {
    // A locked price allows no variance — the customer accepts exactly the
    // locked amount, so any nonzero threshold would be wrong.
    expect(deriveKindAndVariance({ price_kind: "confirmed", tenant_variance_cents: 7500 }).variance_cents).toBe(0);
  });

  it("respects a tenant variance of 0 for an estimate (?? guards null, not 0)", () => {
    // Nullish-coalescing, not ||, so an explicit 0 threshold survives.
    expect(deriveKindAndVariance({ price_kind: "estimate", tenant_variance_cents: 0 }).variance_cents).toBe(0);
  });

  it("falls back to QUOTE_DEFAULT_VARIANCE_CENTS when the tenant hasn't customized it", () => {
    vi.stubEnv("QUOTE_DEFAULT_VARIANCE_CENTS", "4200");
    expect(deriveKindAndVariance({ price_kind: "estimate", tenant_variance_cents: null }).variance_cents).toBe(4200);
    expect(deriveKindAndVariance({ price_kind: "estimate", tenant_variance_cents: undefined }).variance_cents).toBe(4200);
  });

  it("falls back to the hardcoded 5000 default when neither tenant nor env sets a variance", () => {
    vi.stubEnv("QUOTE_DEFAULT_VARIANCE_CENTS", undefined);
    expect(deriveKindAndVariance({ price_kind: "estimate", tenant_variance_cents: null }).variance_cents).toBe(5000);
  });
});

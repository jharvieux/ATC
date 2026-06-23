// EPIC #1336, Phase 2 — stripe_price_map is the source of truth for Stripe
// Price IDs; the STRIPE_PRICE_* env vars are only the fallback. These tests
// encode the WHY:
//   1. A DB row must actually win over the env var — a regression that ignores
//      the loaded map and reads env (reverting Phase 2) fails here.
//   2. A key the DB hasn't been seeded with must fall back to env, so shipping
//      the empty table is a no-op for behavior.
//   3. A read failure / unseeded table must yield an empty map (never throw),
//      and must NOT be cached, so the next call retries the DB.
//   4. priceIdFor throws only when NEITHER source has the key.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/env", () => ({
  env: () => ({
    STRIPE_PRICE_SUBHOST_STARTER_MONTHLY: "price_env_subhost_starter_monthly",
    STRIPE_PRICE_SUBHOST_PRO_MONTHLY: "price_env_subhost_pro_monthly",
    // STRIPE_PRICE_SUBHOST_AGENCY_MONTHLY deliberately unset → exercises the
    // "neither DB nor env" throw path.
  }),
}));

const { loadPriceMap, priceIdFor, _resetPriceMapCacheForTests } = await import(
  "@/lib/stripe/price-ids"
);

type Result = { data: unknown; error: { message: string } | null };

function priceDb(result: Result): SupabaseClient {
  const chain = {
    select: () => chain,
    then: (resolve: (r: Result) => unknown) => resolve(result),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const STARTER_MONTHLY = {
  tenant_type: "sub_host" as const,
  tier: "starter" as const,
  billing_period: "monthly" as const,
  line_item: "base" as const,
};

beforeEach(() => {
  _resetPriceMapCacheForTests();
});

describe("loadPriceMap + priceIdFor", () => {
  it("uses the DB price ID, not the env fallback (source of truth)", async () => {
    const db = priceDb({
      data: [
        {
          tenant_type: "sub_host",
          tier: "starter",
          billing_period: "monthly",
          line_item: "base",
          stripe_price_id: "price_db_starter_monthly",
          amount_cents: 4900,
        },
      ],
      error: null,
    });
    const map = await loadPriceMap(db);
    expect(priceIdFor(STARTER_MONTHLY, map)).toBe("price_db_starter_monthly");
  });

  it("falls back to env for a key the DB hasn't been seeded with", async () => {
    const db = priceDb({ data: [], error: null });
    const map = await loadPriceMap(db);
    // Empty table → env value.
    expect(priceIdFor(STARTER_MONTHLY, map)).toBe("price_env_subhost_starter_monthly");
  });

  it("throws when neither the DB nor env has the key", async () => {
    const map = await loadPriceMap(priceDb({ data: [], error: null }));
    expect(() =>
      priceIdFor({ ...STARTER_MONTHLY, tier: "agency" }, map),
    ).toThrow(/not found in stripe_price_map and env var/);
  });

  it("returns an empty map on a read error without caching it (retries next call)", async () => {
    const failing = priceDb({ data: null, error: { message: "connection reset" } });
    const first = await loadPriceMap(failing);
    expect(first.size).toBe(0);

    // A subsequent successful read must NOT be shadowed by a cached empty map.
    const ok = priceDb({
      data: [
        {
          tenant_type: "sub_host",
          tier: "starter",
          billing_period: "monthly",
          line_item: "base",
          stripe_price_id: "price_db_after_recovery",
          amount_cents: null,
        },
      ],
      error: null,
    });
    const second = await loadPriceMap(ok);
    expect(priceIdFor(STARTER_MONTHLY, second)).toBe("price_db_after_recovery");
  });

  it("defaults to env-only when no map is passed (back-compat)", () => {
    expect(priceIdFor({ ...STARTER_MONTHLY, tier: "pro" })).toBe(
      "price_env_subhost_pro_monthly",
    );
  });
});

// EPIC #1336 Phase 3 — pricing-admin orchestration. Tests encode the WHY:
//   1. A base-price edit creates a NEW Stripe Price (immutability), repoints the
//      product default, and updates BOTH stripe_price_map and tier_definitions
//      (the latter drives display + abuse-revenue math).
//   2. An additional_seats edit updates only stripe_price_map, never tier_definitions.
//   3. A no-op edit (amount already matches the live Price) creates nothing.
//   4. Editing an unseeded key fails closed (no Stripe Price to version) — we
//      never invent a Product or point the DB at a non-existent Price.
//   5. An interval mismatch is rejected (guards against editing the wrong Price).
//   6. The new Price is created with a deterministic idempotency key (retry-safe).
//   7. Seat-ladder validation enforces contiguity + an open-ended final band.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyStripePriceEdit,
  applySeatLadderEdit,
  validateSeatLadder,
  PricingAdminError,
  SEAT_LADDER_OPEN_SENTINEL,
  type StripePriceEdit,
} from "@/lib/stripe/pricing-admin";

type Result = { data: unknown; error: { message: string } | null };

// Records every mutating op as `${table}:${op}` so tests can assert which tables
// were written. Reads resolve under `${table}:read`.
function mockDb(results: Record<string, Result>, ops: string[]): SupabaseClient {
  const make = (table: string) => {
    let op = "read";
    const setOp = (o: string) => {
      if (op === "read") op = o;
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      gt: () => chain,
      order: () => chain,
      update: () => { setOp("update"); return chain; },
      delete: () => { setOp("delete"); return chain; },
      upsert: () => { setOp("upsert"); return chain; },
      then: (resolve: (r: Result) => unknown) => {
        if (op !== "read") ops.push(`${table}:${op}`);
        return resolve(results[`${table}:${op}`] ?? { data: [], error: null });
      },
    };
    return chain;
  };
  return { from: (table: string) => make(table) } as unknown as SupabaseClient;
}

function mockStripe(oldPrice: Partial<Stripe.Price>, createId = "price_new") {
  const retrieve = vi.fn(async () => oldPrice as Stripe.Price);
  const create = vi.fn(async () => ({ id: createId }) as Stripe.Price);
  const update = vi.fn(async () => ({}) as Stripe.Product);
  const stripe = { prices: { retrieve, create }, products: { update } } as unknown as Stripe;
  return { stripe, retrieve, create, update };
}

const BASE_EDIT: StripePriceEdit = {
  tenant_type: "sub_host",
  tier: "pro",
  billing_period: "monthly",
  line_item: "base",
  amount_cents: 19900,
};

const OLD_PRICE: Partial<Stripe.Price> = {
  id: "price_old",
  product: "prod_1",
  currency: "usd",
  unit_amount: 14900,
  recurring: { interval: "month", interval_count: 1 } as Stripe.Price.Recurring,
};

let ops: string[];
beforeEach(() => {
  ops = [];
});

describe("applyStripePriceEdit — base price", () => {
  const results = {
    "stripe_price_map:read": { data: [{ stripe_price_id: "price_old", amount_cents: 14900 }], error: null },
    "stripe_price_map:update": { data: [{ id: "row1" }], error: null },
    "tier_definitions:update": { data: [{ id: "td1" }], error: null },
  };

  it("creates a new Stripe Price, repoints the product, updates both tables", async () => {
    const { stripe, create, update } = mockStripe(OLD_PRICE);
    const db = mockDb(results, ops);

    const res = await applyStripePriceEdit(stripe, db, BASE_EDIT);

    expect(res).toMatchObject({ unchanged: false, stripe_price_id: "price_new", amount_cents: 19900 });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ product: "prod_1", currency: "usd", unit_amount: 19900, recurring: { interval: "month", interval_count: 1 } }),
      expect.objectContaining({ idempotencyKey: "pricing-sub_host.pro.monthly.base-19900-from-price_old" }),
    );
    expect(update).toHaveBeenCalledWith("prod_1", { default_price: "price_new" });
    // Base edits touch BOTH the Stripe map and tier_definitions.
    expect(ops).toContain("stripe_price_map:update");
    expect(ops).toContain("tier_definitions:update");
  });

  it("is a no-op when the amount already matches the live Price (creates nothing)", async () => {
    const { stripe, create, update } = mockStripe(OLD_PRICE);
    const db = mockDb(results, ops);

    const res = await applyStripePriceEdit(stripe, db, { ...BASE_EDIT, amount_cents: 14900 });

    expect(res.unchanged).toBe(true);
    expect(res.stripe_price_id).toBe("price_old");
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(ops).toEqual([]);
  });

  it("rejects an interval mismatch (wrong Price for the period)", async () => {
    const annualPrice = { ...OLD_PRICE, recurring: { interval: "year", interval_count: 1 } as Stripe.Price.Recurring };
    const { stripe, create } = mockStripe(annualPrice);
    const db = mockDb(results, ops);

    await expect(applyStripePriceEdit(stripe, db, BASE_EDIT)).rejects.toMatchObject({
      name: "PricingAdminError",
      code: "interval_mismatch",
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("applyStripePriceEdit — additional_seats", () => {
  it("updates only stripe_price_map, never tier_definitions", async () => {
    const { stripe } = mockStripe(OLD_PRICE);
    const db = mockDb(
      {
        "stripe_price_map:read": { data: [{ stripe_price_id: "price_old", amount_cents: 5900 }], error: null },
        "stripe_price_map:update": { data: [{ id: "row1" }], error: null },
      },
      ops,
    );

    await applyStripePriceEdit(stripe, db, {
      tenant_type: "sub_host",
      tier: "agency",
      billing_period: "monthly",
      line_item: "additional_seats",
      amount_cents: 6900,
    });

    expect(ops).toContain("stripe_price_map:update");
    expect(ops).not.toContain("tier_definitions:update");
  });
});

describe("applyStripePriceEdit — fail-closed", () => {
  it("throws price_not_seeded for an unseeded key and touches Stripe not at all", async () => {
    const { stripe, retrieve, create } = mockStripe(OLD_PRICE);
    const db = mockDb({ "stripe_price_map:read": { data: [], error: null } }, ops);

    await expect(applyStripePriceEdit(stripe, db, BASE_EDIT)).rejects.toMatchObject({
      name: "PricingAdminError",
      code: "price_not_seeded",
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(ops).toEqual([]);
  });

  it("rejects a negative amount before any work", async () => {
    const { stripe, retrieve } = mockStripe(OLD_PRICE);
    const db = mockDb({}, ops);
    await expect(
      applyStripePriceEdit(stripe, db, { ...BASE_EDIT, amount_cents: -1 }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("validateSeatLadder", () => {
  const good = [
    { up_to_seat: 5, monthly_cents: 5900, annual_cents: 59000, sort_order: 1 },
    { up_to_seat: SEAT_LADDER_OPEN_SENTINEL, monthly_cents: 3900, annual_cents: 39000, sort_order: 2 },
  ];

  it("accepts a contiguous ladder ending in the open sentinel", () => {
    expect(() => validateSeatLadder(good)).not.toThrow();
  });

  it("rejects a non-contiguous sort_order", () => {
    const bad = [
      { up_to_seat: 5, monthly_cents: 5900, annual_cents: 59000, sort_order: 1 },
      { up_to_seat: SEAT_LADDER_OPEN_SENTINEL, monthly_cents: 3900, annual_cents: 39000, sort_order: 3 },
    ];
    expect(() => validateSeatLadder(bad)).toThrow(PricingAdminError);
  });

  it("rejects a final band that is not open-ended", () => {
    const bad = [{ up_to_seat: 5, monthly_cents: 5900, annual_cents: 59000, sort_order: 1 }];
    expect(() => validateSeatLadder(bad)).toThrow(/open-ended/);
  });

  it("rejects non-increasing up_to_seat", () => {
    const bad = [
      { up_to_seat: 5, monthly_cents: 5900, annual_cents: 59000, sort_order: 1 },
      { up_to_seat: 5, monthly_cents: 3900, annual_cents: 39000, sort_order: 2 },
    ];
    expect(() => validateSeatLadder(bad)).toThrow(PricingAdminError);
  });
});

describe("applySeatLadderEdit", () => {
  it("upserts the bands and deletes trailing rows, returning the count", async () => {
    const db = mockDb(
      {
        "pricing_seat_ladder:upsert": { data: null, error: null },
        "pricing_seat_ladder:delete": { data: null, error: null },
      },
      ops,
    );
    const bands = [
      { up_to_seat: 5, monthly_cents: 5900, annual_cents: 59000, sort_order: 1 },
      { up_to_seat: SEAT_LADDER_OPEN_SENTINEL, monthly_cents: 3900, annual_cents: 39000, sort_order: 2 },
    ];
    const res = await applySeatLadderEdit(db, bands);
    expect(res.band_count).toBe(2);
    expect(ops).toContain("pricing_seat_ladder:upsert");
    expect(ops).toContain("pricing_seat_ladder:delete");
  });
});

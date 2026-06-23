// EPIC #1336 Phase 3 — the orchestration behind the platform-admin pricing
// screen. Editing a price here pushes the change to Stripe and the DB together.
//
// Stripe Prices are immutable, so "editing" a price means: create a NEW Price
// under the same Product, repoint the Product's default_price, then update our
// DB references (stripe_price_map for every line item; tier_definitions too for
// base prices, which drive display + §27 abuse-revenue math). Existing
// subscriptions keep their locked-in Price; the new Price only applies to new
// checkouts.
//
// Ordering is chosen so a mid-flight failure is always recoverable by a retry:
//   1. create the new Price (idempotent key → a retry returns the same Price)
//   2. repoint the Product default
//   3. CAS-update stripe_price_map (guarded on the old Price ID → concurrent
//      edits can't clobber each other; a stale retry re-converges)
//   4. update tier_definitions (base line items only)
// Steps 1-2 touch only Stripe; if 3 fails the DB still points at the old (live)
// Price, so checkout keeps working. Nothing here mutates without a checked
// result (D-091 §3/§7), and we never point the DB at a Price that doesn't exist
// (fail-closed §2).
//
// Stripe + the DB client are injected so this is unit-testable without network.

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait, safeAwaitRowCount } from "@/lib/db/safe-mutation";
import { TIER_CODE } from "@/lib/stripe/tier-codes";
import type { TenantType, Tier, BillingPeriod, LineItem } from "@/lib/stripe/price-ids";

export class PricingAdminError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PricingAdminError";
  }
}

export interface StripePriceEdit {
  tenant_type: TenantType;
  tier: Tier;
  billing_period: BillingPeriod;
  line_item: LineItem;
  amount_cents: number;
}

export interface StripePriceEditResult {
  key: string;
  unchanged: boolean;
  stripe_price_id: string;
  amount_cents: number;
}

function keyOf(e: { tenant_type: string; tier: string; billing_period: string; line_item: string }): string {
  return `${e.tenant_type}.${e.tier}.${e.billing_period}.${e.line_item}`;
}

function productIdOf(price: Stripe.Price): string {
  const p = price.product;
  if (typeof p === "string") return p;
  if (p && "id" in p) return p.id;
  throw new PricingAdminError("stripe_product_missing", "Stripe Price has no resolvable product.");
}

// Apply one Stripe-backed price edit (a 'base' or 'additional_seats' line item).
// Throws PricingAdminError on any precondition failure; the caller surfaces it.
export async function applyStripePriceEdit(
  stripe: Stripe,
  db: SupabaseClient,
  edit: StripePriceEdit,
): Promise<StripePriceEditResult> {
  if (!Number.isInteger(edit.amount_cents) || edit.amount_cents < 0) {
    throw new PricingAdminError("invalid_amount", "amount_cents must be a non-negative integer.");
  }

  const key = keyOf(edit);

  const existing = await safeAwait<{ stripe_price_id: string; amount_cents: number | null }[]>(
    db
      .from("stripe_price_map")
      .select("stripe_price_id, amount_cents")
      .eq("tenant_type", edit.tenant_type)
      .eq("tier", edit.tier)
      .eq("billing_period", edit.billing_period)
      .eq("line_item", edit.line_item),
    "stripe_price_map.select_for_edit",
  );
  const currentRow = existing?.[0];
  if (!currentRow?.stripe_price_id) {
    // Without a seeded Price we have no Product to attach a new Price to.
    throw new PricingAdminError(
      "price_not_seeded",
      `No Stripe Price seeded for ${key}. Seed stripe_price_map (Phase 2 backfill) before editing.`,
    );
  }
  const oldPriceId = currentRow.stripe_price_id;

  const oldPrice = await stripe.prices.retrieve(oldPriceId);
  if (!oldPrice.recurring) {
    throw new PricingAdminError("price_not_recurring", `Stripe Price ${oldPriceId} is not recurring.`);
  }
  const expectedInterval = edit.billing_period === "annual" ? "year" : "month";
  if (oldPrice.recurring.interval !== expectedInterval) {
    throw new PricingAdminError(
      "interval_mismatch",
      `Stripe Price ${oldPriceId} interval '${oldPrice.recurring.interval}' != expected '${expectedInterval}'.`,
    );
  }

  // No-op edit: amount already matches the live Stripe Price. Skip the churn.
  if (oldPrice.unit_amount === edit.amount_cents) {
    return { key, unchanged: true, stripe_price_id: oldPriceId, amount_cents: edit.amount_cents };
  }

  const productId = productIdOf(oldPrice);

  const newPrice = await stripe.prices.create(
    {
      product: productId,
      currency: oldPrice.currency,
      unit_amount: edit.amount_cents,
      recurring: {
        interval: oldPrice.recurring.interval,
        interval_count: oldPrice.recurring.interval_count,
      },
    },
    // Deterministic key: a network retry of this exact edit reuses the same new
    // Price instead of creating duplicates.
    { idempotencyKey: `pricing-${key}-${edit.amount_cents}-from-${oldPriceId}` },
  );

  // Cosmetic for our flow (checkout uses explicit Price IDs) but keeps the
  // Stripe dashboard honest. Done before the DB write so a failure here leaves
  // DB + Stripe-default both on the old Price (consistent).
  await stripe.products.update(productId, { default_price: newPrice.id });

  // CAS on the old Price ID: a concurrent editor who already repointed this key
  // changes the guard, so our update matches 0 rows and throws — the operator
  // re-reads and retries rather than silently losing an edit.
  await safeAwaitRowCount(
    db
      .from("stripe_price_map")
      .update({ stripe_price_id: newPrice.id, amount_cents: edit.amount_cents, updated_at: new Date().toISOString() })
      .eq("tenant_type", edit.tenant_type)
      .eq("tier", edit.tier)
      .eq("billing_period", edit.billing_period)
      .eq("line_item", edit.line_item)
      .eq("stripe_price_id", oldPriceId)
      .select("id"),
    "stripe_price_map.cas_repoint",
    1,
  );

  // Base prices also live in tier_definitions (display + abuse-revenue scaling).
  if (edit.line_item === "base") {
    const code = TIER_CODE[edit.tenant_type][edit.tier];
    const column = edit.billing_period === "annual" ? "base_price_annual_cents" : "base_price_monthly_cents";
    await safeAwaitRowCount(
      db
        .from("tier_definitions")
        .update({ [column]: edit.amount_cents })
        .eq("code", code)
        .select("id"),
      "tier_definitions.update_base_price",
      1,
    );
  }

  return { key, unchanged: false, stripe_price_id: newPrice.id, amount_cents: edit.amount_cents };
}

export interface SeatLadderBand {
  up_to_seat: number;
  monthly_cents: number;
  annual_cents: number;
  sort_order: number;
}

// The open-ended final band uses INT4-max as the "and up" sentinel (matches the
// migration + loadPricingTable).
export const SEAT_LADDER_OPEN_SENTINEL = 2147483647;

export function validateSeatLadder(bands: SeatLadderBand[]): void {
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new PricingAdminError("invalid_seat_ladder", "Seat ladder must have at least one band.");
  }
  const sorted = [...bands].sort((a, b) => a.sort_order - b.sort_order);
  let lastUpTo = 1; // seat 1 is the base seat; bands price seats 2+
  for (const [i, b] of sorted.entries()) {
    if (!Number.isInteger(b.sort_order) || b.sort_order !== i + 1) {
      throw new PricingAdminError("invalid_seat_ladder", "sort_order must be a contiguous 1..N sequence.");
    }
    if (!Number.isInteger(b.up_to_seat) || b.up_to_seat <= lastUpTo) {
      throw new PricingAdminError("invalid_seat_ladder", "up_to_seat must strictly increase across bands.");
    }
    if (!Number.isInteger(b.monthly_cents) || b.monthly_cents < 0 || !Number.isInteger(b.annual_cents) || b.annual_cents < 0) {
      throw new PricingAdminError("invalid_seat_ladder", "Band amounts must be non-negative integers.");
    }
    lastUpTo = b.up_to_seat;
  }
  const last = sorted[sorted.length - 1];
  if (!last || last.up_to_seat !== SEAT_LADDER_OPEN_SENTINEL) {
    throw new PricingAdminError(
      "invalid_seat_ladder",
      `The final band must be open-ended (up_to_seat = ${SEAT_LADDER_OPEN_SENTINEL}).`,
    );
  }
}

// DB-only edit of the graduated seat ladder (display + abuse math; no Stripe
// linkage). Full replacement: upsert every submitted band by sort_order, then
// delete any trailing bands the operator removed. Upsert-before-delete means a
// failed delete leaves only harmless extra high bands, never a gap.
export async function applySeatLadderEdit(db: SupabaseClient, bands: SeatLadderBand[]): Promise<{ band_count: number }> {
  validateSeatLadder(bands);

  await safeAwait(
    db
      .from("pricing_seat_ladder")
      .upsert(
        bands.map((b) => ({
          up_to_seat: b.up_to_seat,
          monthly_cents: b.monthly_cents,
          annual_cents: b.annual_cents,
          sort_order: b.sort_order,
        })),
        { onConflict: "sort_order" },
      ),
    "pricing_seat_ladder.upsert",
  );

  await safeAwait(
    db.from("pricing_seat_ladder").delete().gt("sort_order", bands.length),
    "pricing_seat_ladder.delete_trailing",
  );

  return { band_count: bands.length };
}

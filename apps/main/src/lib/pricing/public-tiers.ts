// Public list pricing for the three bring-your-own-host tiers.
//
// Exists so the rendered pricing table (AgencyPricing.tsx) and the
// schema.org Offer markup on the homepage read the same numbers. Search
// engines treat an Offer price that contradicts the visible price as
// structured-data spam and can demote or drop the rich result, so these
// two surfaces must not be able to drift.
//
// Not the billing source of truth — Stripe price IDs live in
// stripe_price_map (D-292). These are the marketing-page list prices.

export interface PublicTier {
  name: string;
  monthlyUsd: number;
  annualUsd: number;
}

export const PUBLIC_TIERS: readonly PublicTier[] = [
  { name: "Research", monthlyUsd: 19, annualUsd: 190 },
  { name: "Professional", monthlyUsd: 59, annualUsd: 590 },
  { name: "Agency", monthlyUsd: 99, annualUsd: 990 },
];

export function tierByName(name: string): PublicTier {
  const tier = PUBLIC_TIERS.find((t) => t.name === name);
  if (!tier) throw new Error(`Unknown public tier: ${name}`);
  return tier;
}

/** Dollars saved by paying yearly instead of twelve monthly charges. */
export function annualSavingsUsd(tier: PublicTier): number {
  return tier.monthlyUsd * 12 - tier.annualUsd;
}

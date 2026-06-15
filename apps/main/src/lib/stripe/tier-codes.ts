// §3.3 / §15.8 / §15.15 — Canonical maps between {tenant_type, tier} and tier_definitions.code.
// tier_definitions.code is type-prefixed (byo_agency); priceIdFor and Stripe calls take bare Tier.
// These maps are the single source of truth — referenced by the tier, checkout, and billing routes.

import type { TenantType, Tier } from "@/lib/stripe/price-ids";
import type { TenantTierCode } from "@/lib/abuse/revenue";

export const TIER_CODE: Record<TenantType, Record<Tier, TenantTierCode>> = {
  byo_host: { starter: "byo_research", pro: "byo_professional", agency: "byo_agency" },
  sub_host: { starter: "sub_starter",  pro: "sub_pro",          agency: "sub_agency" },
};

export const CODE_TO_TIER: Record<TenantTierCode, Tier> = {
  byo_research:     "starter",
  byo_professional: "pro",
  byo_agency:       "agency",
  sub_starter:      "starter",
  sub_pro:          "pro",
  sub_agency:       "agency",
};

// §3.3 / §15.8 / §15.15 — Canonical maps between {tenant_type, tier} and tier_definitions.code.
// tier_definitions.code is type-prefixed (byo_agency); priceIdFor and Stripe calls take bare Tier.
// Literals live in tier-code-map.ts (import-free) so client components can import that module
// directly. This file re-exports them with strong types for server-side call sites.

import type { TenantType, Tier } from "@/lib/stripe/price-ids";
import type { TenantTierCode } from "@/lib/abuse/revenue";
import { TIER_CODE_MAP, CODE_TO_TIER_MAP } from "@/lib/stripe/tier-code-map";

export const TIER_CODE = TIER_CODE_MAP as Record<TenantType, Record<Tier, TenantTierCode>>;
export const CODE_TO_TIER = CODE_TO_TIER_MAP as Record<TenantTierCode, Tier>;

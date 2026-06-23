// §15.8 — The canonical (tenant_type.tier.billing_period.line_item) → env-var
// mapping for Stripe Price IDs. Kept in its own module, free of `@/` aliases and
// runtime imports, so the Phase 2 backfill (scripts/seed-stripe-price-map.ts) can
// import it via a relative path under plain tsx — exactly how scripts share
// tenant-scoped-tables.ts. priceIdFor()'s DB-miss fallback reads the same map.

export const PRICE_ID_ENV_MAP: Record<string, string> = {
  "sub_host.starter.monthly.base":            "STRIPE_PRICE_SUBHOST_STARTER_MONTHLY",
  "sub_host.starter.annual.base":             "STRIPE_PRICE_SUBHOST_STARTER_ANNUAL",
  "sub_host.pro.monthly.base":                "STRIPE_PRICE_SUBHOST_PRO_MONTHLY",
  "sub_host.pro.annual.base":                 "STRIPE_PRICE_SUBHOST_PRO_ANNUAL",
  "sub_host.agency.monthly.base":             "STRIPE_PRICE_SUBHOST_AGENCY_MONTHLY",
  "sub_host.agency.annual.base":              "STRIPE_PRICE_SUBHOST_AGENCY_ANNUAL",
  "sub_host.agency.monthly.additional_seats": "STRIPE_PRICE_SUBHOST_AGENCY_SEATS_MONTHLY",
  "sub_host.agency.annual.additional_seats":  "STRIPE_PRICE_SUBHOST_AGENCY_SEATS_ANNUAL",
  "byo_host.starter.monthly.base":            "STRIPE_PRICE_BYO_RESEARCH_MONTHLY",
  "byo_host.starter.annual.base":             "STRIPE_PRICE_BYO_RESEARCH_ANNUAL",
  "byo_host.pro.monthly.base":                "STRIPE_PRICE_BYO_PROFESSIONAL_MONTHLY",
  "byo_host.pro.annual.base":                 "STRIPE_PRICE_BYO_PROFESSIONAL_ANNUAL",
  "byo_host.agency.monthly.base":             "STRIPE_PRICE_BYO_AGENCY_MONTHLY",
  "byo_host.agency.annual.base":              "STRIPE_PRICE_BYO_AGENCY_ANNUAL",
  "byo_host.agency.monthly.additional_seats": "STRIPE_PRICE_BYO_AGENCY_SEATS_MONTHLY",
  "byo_host.agency.annual.additional_seats":  "STRIPE_PRICE_BYO_AGENCY_SEATS_ANNUAL",
};

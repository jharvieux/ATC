// §14.x / §15.8 — Stripe Price ID centralization.
//
// Maps tenant type + tier + billing period to the correct Stripe Price ID.
// Price IDs are loaded from env vars. All references go through priceIdFor().

import { env } from "@/lib/env";

export type TenantType = "sub_host" | "byo_host";
export type Tier = "starter" | "pro" | "agency";
export type BillingPeriod = "monthly" | "annual";
export type LineItem = "base" | "additional_seats";

export interface PriceIdQuery {
  tenant_type: TenantType;
  tier: Tier;
  billing_period: BillingPeriod;
  line_item: LineItem;
}

const PRICE_ID_MAP: Record<string, keyof ReturnType<typeof env>> = {
  "sub_host.starter.monthly.base":          "STRIPE_PRICE_SUBHOST_STARTER_MONTHLY",
  "sub_host.starter.annual.base":           "STRIPE_PRICE_SUBHOST_STARTER_ANNUAL",
  "sub_host.pro.monthly.base":              "STRIPE_PRICE_SUBHOST_PRO_MONTHLY",
  "sub_host.pro.annual.base":               "STRIPE_PRICE_SUBHOST_PRO_ANNUAL",
  "sub_host.agency.monthly.base":           "STRIPE_PRICE_SUBHOST_AGENCY_MONTHLY",
  "sub_host.agency.annual.base":            "STRIPE_PRICE_SUBHOST_AGENCY_ANNUAL",
  "sub_host.agency.monthly.additional_seats": "STRIPE_PRICE_SUBHOST_AGENCY_SEATS_MONTHLY",
  "sub_host.agency.annual.additional_seats":  "STRIPE_PRICE_SUBHOST_AGENCY_SEATS_ANNUAL",
  "byo_host.starter.monthly.base":          "STRIPE_PRICE_BYO_RESEARCH_MONTHLY",
  "byo_host.starter.annual.base":           "STRIPE_PRICE_BYO_RESEARCH_ANNUAL",
  "byo_host.pro.monthly.base":              "STRIPE_PRICE_BYO_PROFESSIONAL_MONTHLY",
  "byo_host.pro.annual.base":               "STRIPE_PRICE_BYO_PROFESSIONAL_ANNUAL",
  "byo_host.agency.monthly.base":           "STRIPE_PRICE_BYO_AGENCY_MONTHLY",
  "byo_host.agency.annual.base":            "STRIPE_PRICE_BYO_AGENCY_ANNUAL",
  "byo_host.agency.monthly.additional_seats": "STRIPE_PRICE_BYO_AGENCY_SEATS_MONTHLY",
  "byo_host.agency.annual.additional_seats":  "STRIPE_PRICE_BYO_AGENCY_SEATS_ANNUAL",
};

export function priceIdFor(query: PriceIdQuery): string {
  const key = `${query.tenant_type}.${query.tier}.${query.billing_period}.${query.line_item}`;
  const envKey = PRICE_ID_MAP[key];
  if (!envKey) {
    throw new Error(`No Stripe Price ID mapping for: ${key}`);
  }
  const e = env();
  const priceId = (e as unknown as Record<string, string | undefined>)[envKey as string];
  if (!priceId) {
    throw new Error(`Stripe Price ID env var '${envKey}' is not set.`);
  }
  return priceId;
}

/**
 * Preview pricing for the Agency tier seat ladder.
 * Per §3.3: $59/seat (1), $49/seat (2-5), $39/seat (6+) — monthly.
 * Annual: same ladder × 10 (2 months free).
 */
export function calculateAgencySeatPreviewCents(
  seatCount: number,
  billingPeriod: BillingPeriod,
): number {
  const BANDS = [
    { upTo: 1,   rateMonthly: 5900 },  // $59/seat/month
    { upTo: 5,   rateMonthly: 4900 },  // $49/seat/month
    { upTo: Infinity, rateMonthly: 3900 }, // $39/seat/month
  ];

  let totalCents = 0;
  let remaining = seatCount;
  let prevThreshold = 0;

  for (const band of BANDS) {
    if (remaining <= 0) break;
    const inBand = Math.min(remaining, band.upTo - prevThreshold);
    totalCents += inBand * band.rateMonthly;
    remaining -= inBand;
    prevThreshold = band.upTo;
  }

  return billingPeriod === "annual" ? totalCents * 10 : totalCents;
}

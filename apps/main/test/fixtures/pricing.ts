// §3.3 seed values — shared test fixture, not a runtime fallback.
import type { PricingTable } from "@/lib/abuse/revenue";

export const PRICING_FIXTURE: PricingTable = {
  base: {
    byo_research:     { monthly:  1900, annual:  19000 },
    byo_professional: { monthly:  5900, annual:  59000 },
    byo_agency:       { monthly:  9900, annual:  99000 },
    sub_starter:      { monthly:  4900, annual:  49000 },
    sub_pro:          { monthly: 14900, annual: 149000 },
    sub_agency:       { monthly: 24900, annual: 249000 },
  },
  seatLadder: [
    { upTo:        4, monthly: 5900, annual: 59000 }, // users 2–4
    { upTo:       10, monthly: 4900, annual: 49000 }, // users 5–10
    { upTo: Infinity, monthly: 3900, annual: 39000 }, // users 11+
  ],
};

// §3.3 / §15.8 — Raw tier-code literals, free of @/ aliases and runtime imports.
// Kept separate so client components (e.g. the admin pricing page) can import
// without pulling in server-only transitive dependencies. tier-codes.ts imports
// these and re-exports them with strong types for server-side call sites.
// Mirror of the price-id-map.ts pattern used in Phase 2.

export const TIER_CODE_MAP: Record<string, Record<string, string>> = {
  byo_host: { starter: "byo_research", pro: "byo_professional", agency: "byo_agency" },
  sub_host: { starter: "sub_starter",  pro: "sub_pro",          agency: "sub_agency" },
};

export const CODE_TO_TIER_MAP: Record<string, string> = {
  byo_research:     "starter",
  byo_professional: "pro",
  byo_agency:       "agency",
  sub_starter:      "starter",
  sub_pro:          "pro",
  sub_agency:       "agency",
};

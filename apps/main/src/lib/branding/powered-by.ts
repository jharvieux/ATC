// §16.7 — Powered-by tier-gating rules.
// The branding API forces show_powered_by=TRUE for the three lowest tiers
// regardless of what the tenant sends. Higher tiers can toggle freely.

const FORCED_POWERED_BY_TIERS = new Set(["byo_research", "byo_professional", "sub_starter"]);

export function resolveShowPoweredBy(
  tierCode: string | null | undefined,
  requested: boolean | undefined,
): boolean {
  if (tierCode != null && FORCED_POWERED_BY_TIERS.has(tierCode)) return true;
  return requested ?? true;
}

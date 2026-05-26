// §33.7 D-088 — Price-anchor rounding rule for AI-generated prose.
//
// Operator decision (D-088, walkthrough 2026-05-26): when the AI mentions a
// price that isn't from a confirmed quote (§21.10.1), it should soften
// the number with "approximately / around" language AND apply the
// following math:
//
//   1. Multiply by 1.10 (10% buffer to avoid undersell)
//   2. Round to the NEAREST $100 (banker's rounding not required;
//      JavaScript's Math.round-half-away-from-zero is fine for dollars)
//
// The rule is feature-flagged: when AI_PRICE_ROUNDING_ENABLED=false the
// formatter passes prices through unchanged (for emergencies or A/B testing).

export function isPriceRoundingEnabled(): boolean {
  // Default ON. Operator sets =false to disable.
  return process.env.AI_PRICE_ROUNDING_ENABLED !== "false";
}

/** Round one dollar value through the +10% / nearest-$100 rule.
 *  Pass-through if AI_PRICE_ROUNDING_ENABLED=false. */
export function roundPriceAnchor(usd: number): number {
  if (!isPriceRoundingEnabled()) return usd;
  if (!Number.isFinite(usd) || usd <= 0) return usd;
  const buffered = usd * 1.1;
  return Math.round(buffered / 100) * 100;
}

/** Format a low/high range for AI prose. Always returns "around $X to $Y"
 *  in dollars, even if the rule is disabled (the framing word still
 *  applies — only the rounding is conditional). */
export function formatPriceAnchorRange(lowUsd: number, highUsd: number): string {
  const lo = roundPriceAnchor(lowUsd);
  const hi = roundPriceAnchor(highUsd);
  // Dollar-format with commas, no decimals (we rounded to $100 above).
  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  if (lo === hi) return `around ${fmt(lo)}`;
  return `around ${fmt(lo)} to ${fmt(hi)}`;
}

/** Format a single price (no range). "around $X" framing. */
export function formatPriceAnchorSingle(usd: number): string {
  const r = roundPriceAnchor(usd);
  return `around $${Math.round(r).toLocaleString("en-US")}`;
}

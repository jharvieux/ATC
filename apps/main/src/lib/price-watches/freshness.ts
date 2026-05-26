// §33.8.3 freshness gate — pure helpers for the price-watch evaluator.
//
// Extracted so the gate logic can be unit-tested independently of the
// Inngest cron, Supabase client, and Apify adapter.

/** Threshold parsing with a safe fallback. Mirrors the spec's
 *  PRICE_FRESHNESS_FRESH_HOURS env var (default 72h per §33.10). */
export function resolveFreshHours(envValue: string | undefined): number {
  const n = Number(envValue ?? "72");
  return Number.isFinite(n) && n > 0 ? n : 72;
}

/** True iff a cached pricing row is fresh enough to trigger a watch.
 *  Stale or missing fetched_at → not fresh (skip the watch for this run). */
export function isFresh(
  fetchedAtIso: string | null | undefined,
  nowMs: number,
  freshHours: number,
): boolean {
  if (!fetchedAtIso) return false;
  const fetchedAtMs = Date.parse(fetchedAtIso);
  if (!Number.isFinite(fetchedAtMs)) return false;
  const ageMs = nowMs - fetchedAtMs;
  return ageMs <= freshHours * 3_600_000;
}

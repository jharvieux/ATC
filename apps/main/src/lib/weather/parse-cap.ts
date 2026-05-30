// §23.4 — Shared parser for the Open-Meteo daily-cap setting.
//
// platform_settings.value is JSONB so the cap can arrive as a bare number
// (the migration's `'8000'::JSONB` form) or as a string ("8000") via the
// generic settings UI. Bottle-necking through one parser keeps the cast
// rule consistent across helper, admin route, and alert cron.

export function parseDailyCap(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

// Open-Meteo free-tier ceiling. Source:
//   https://open-meteo.com/en/pricing  (10,000 API requests/day free tier)
// If this changes upstream we want a single replacement point.
export const OPEN_METEO_FREE_TIER_CEILING = 10000;

export const FALLBACK_DAILY_CAP = 8000;

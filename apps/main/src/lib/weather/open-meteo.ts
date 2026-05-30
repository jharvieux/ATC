// §23.6 — Open-Meteo embarkation-port forecast helper.
//
// Three things this module does, in order, per call:
//
//   1. Read today's count from weather_usage_metrics + the daily cap from
//      platform_settings. If at-or-over cap, emit a "platform.weather_rate_limit_hit"
//      event and return null. Cap defaults to 8000 (2000-req headroom under
//      Open-Meteo's 10000/day free tier).
//
//   2. Check weather_forecast_cache for a fresh row keyed on
//      (port_id, forecast_date). A row counts as fresh if fetched_at is
//      within CACHE_TTL_HOURS of now. Stale rows are ignored (the next
//      successful fetch overwrites them via UPSERT).
//
//   3. Fetch Open-Meteo, parse, store in cache, increment the counter via
//      the SECURITY DEFINER `increment_weather_usage()` RPC (atomic ON
//      CONFLICT … RETURNING). Return the normalized forecast.
//
// FAILURE MODES — all return null so the caller (email-generation) silently
// omits the weather section rather than failing the email:
//   - Rate-limit exhausted today
//   - Open-Meteo HTTP error / timeout
//   - Response shape unexpected
//   - DB read/write error (logged, doesn't throw)
//
// The cache lives in the main app's Supabase project; the helper uses
// the service-role client (no tenant context — weather is platform-scoped).
// The lint allowlist for direct service-role import covers this file.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "@/inngest/client";
import { wmoCodeToText } from "./wmo-codes";

export interface WeatherForecast {
  high_f: number;
  low_f: number;
  precipitation_in: number;
  conditions: string;
  fetched_at: string;
}

export interface GetForecastOpts {
  port_id: string;
  latitude: number;
  longitude: number;
  date: string;
}

const CACHE_TTL_HOURS = 6;
const FALLBACK_DAILY_CAP = 8000;
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const FETCH_TIMEOUT_MS = 8000;

interface OpenMeteoResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_sum?: (number | null)[];
    weathercode?: (number | null)[];
  };
}

interface CacheRow {
  payload: WeatherForecast;
  fetched_at: string;
}

interface UsageRow {
  requests_count: number;
}

interface PlatformSettingRow {
  value: unknown;
}

export async function getEmbarkationForecast(
  opts: GetForecastOpts,
): Promise<WeatherForecast | null> {
  const db = createServiceRoleClient();

  const cap = await readDailyCap(db);
  const todayCount = await readTodayCount(db);

  if (todayCount >= cap) {
    await inngest.send({
      name: "platform.weather_rate_limit_hit",
      data: {
        cap,
        today_count: todayCount,
        port_id: opts.port_id,
      },
    });
    return null;
  }

  const cached = await readCache(db, opts.port_id, opts.date);
  if (cached && isFresh(cached.fetched_at)) {
    return cached.payload;
  }

  const fetched = await fetchOpenMeteo(opts);
  if (!fetched) return null;

  await writeCache(db, opts.port_id, opts.date, fetched);
  await incrementUsage(db);

  return fetched;
}

async function readDailyCap(
  db: ReturnType<typeof createServiceRoleClient>,
): Promise<number> {
  const { data, error } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "weather_daily_request_cap")
    .maybeSingle<PlatformSettingRow>();

  if (error || !data) return FALLBACK_DAILY_CAP;

  const raw = data.value;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return FALLBACK_DAILY_CAP;
}

async function readTodayCount(
  db: ReturnType<typeof createServiceRoleClient>,
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from("weather_usage_metrics")
    .select("requests_count")
    .eq("metric_date", today)
    .maybeSingle<UsageRow>();

  if (error || !data) return 0;
  return data.requests_count;
}

async function readCache(
  db: ReturnType<typeof createServiceRoleClient>,
  port_id: string,
  date: string,
): Promise<CacheRow | null> {
  const { data, error } = await db
    .from("weather_forecast_cache")
    .select("payload, fetched_at")
    .eq("port_id", port_id)
    .eq("forecast_date", date)
    .maybeSingle<CacheRow>();

  if (error || !data) return null;
  return data;
}

async function writeCache(
  db: ReturnType<typeof createServiceRoleClient>,
  port_id: string,
  date: string,
  payload: WeatherForecast,
): Promise<void> {
  const { error } = await db
    .from("weather_forecast_cache")
    .upsert(
      {
        port_id,
        forecast_date: date,
        payload,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "port_id,forecast_date" },
    );
  if (error) {
    console.warn(
      `[weather] cache upsert failed for ${port_id}/${date}: ${error.message}`,
    );
  }
}

async function incrementUsage(
  db: ReturnType<typeof createServiceRoleClient>,
): Promise<void> {
  const { error } = await db.rpc("increment_weather_usage");
  if (error) {
    console.warn(`[weather] usage increment failed: ${error.message}`);
  }
}

function isFresh(fetchedAt: string): boolean {
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return false;
  const ageMs = Date.now() - fetchedMs;
  return ageMs >= 0 && ageMs < CACHE_TTL_HOURS * 60 * 60 * 1000;
}

async function fetchOpenMeteo(
  opts: GetForecastOpts,
): Promise<WeatherForecast | null> {
  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set("latitude", String(opts.latitude));
  url.searchParams.set("longitude", String(opts.longitude));
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode",
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", opts.date);
  url.searchParams.set("end_date", opts.date);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[weather] open-meteo returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as OpenMeteoResponse;
    return parseResponse(body);
  } catch (err) {
    console.warn(
      `[weather] open-meteo fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseResponse(body: OpenMeteoResponse): WeatherForecast | null {
  const d = body.daily;
  const high = d?.temperature_2m_max?.[0];
  const low = d?.temperature_2m_min?.[0];
  const precip = d?.precipitation_sum?.[0];
  const code = d?.weathercode?.[0];

  if (
    high == null ||
    low == null ||
    precip == null ||
    code == null
  ) {
    return null;
  }

  return {
    high_f: Math.round(high),
    low_f: Math.round(low),
    precipitation_in: Math.round(precip * 100) / 100,
    conditions: wmoCodeToText(code),
    fetched_at: new Date().toISOString(),
  };
}

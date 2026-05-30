// §23.6 — getEmbarkationForecast contract.
//
// The cases below pin the WHY for each behavior:
//   - rate-limit gate must FIRE the inngest event AND return null (the
//     email cron will silently omit the section)
//   - cache hits within TTL skip the network entirely (free-tier savings)
//   - stale cache rows fall through to fetch (don't wait for DB-level TTL)
//   - Open-Meteo HTTP error returns null (degrade silently, not throw)
//   - successful fetch upserts the cache AND increments the counter
//     (so the next day's quota math is correct)

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

const {
  mockSend,
  mockPlatformSettings,
  mockUsage,
  mockCacheSelect,
  mockCacheUpsert,
  mockRpc,
} = vi.hoisted(() => ({
  mockSend: vi.fn(async (_event: unknown) => {}),
  mockPlatformSettings: vi.fn(),
  mockUsage: vi.fn(),
  mockCacheSelect: vi.fn(),
  mockCacheUpsert: vi.fn<
    () => Promise<{ error: { message: string } | null }>
  >(async () => ({ error: null })),
  mockRpc: vi.fn<
    () => Promise<{ data: number | null; error: { message: string } | null }>
  >(async () => ({ data: 1, error: null })),
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: mockSend },
}));

function clientFactory() {
  return {
    rpc: mockRpc,
    from(table: string) {
      if (table === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mockPlatformSettings }),
          }),
        };
      }
      if (table === "weather_usage_metrics") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mockUsage }),
          }),
        };
      }
      if (table === "weather_forecast_cache") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: mockCacheSelect }),
            }),
          }),
          upsert: mockCacheUpsert,
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => clientFactory(),
}));

import { getEmbarkationForecast } from "@/lib/weather/open-meteo";

const ORIGINAL_FETCH = globalThis.fetch;

function openMeteoOk(
  body: Record<string, unknown>,
): Mock {
  const m = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = m as unknown as typeof fetch;
  return m;
}

const VALID_OPEN_METEO_BODY = {
  daily: {
    time: ["2026-06-10"],
    temperature_2m_max: [82.4],
    temperature_2m_min: [71.0],
    precipitation_sum: [0.12],
    weathercode: [2],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  mockPlatformSettings.mockResolvedValue({ data: { value: 8000 }, error: null });
  mockUsage.mockResolvedValue({ data: { requests_count: 100 }, error: null });
  mockCacheSelect.mockResolvedValue({ data: null, error: null });
});

const OPTS = {
  port_id: "miami",
  latitude: 25.7617,
  longitude: -80.1918,
  date: "2026-06-10",
};

describe("fail-closed on DB-read errors", () => {
  it("returns null without fetching when platform_settings read errors (deny, not 8000 default)", async () => {
    mockPlatformSettings.mockResolvedValue({
      data: null,
      error: { message: "connection refused", code: "PGRST" },
    });
    const fetchMock = openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns null without fetching when weather_usage_metrics read errors", async () => {
    mockUsage.mockResolvedValue({
      data: null,
      error: { message: "permission denied", code: "42501" },
    });
    const fetchMock = openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats missing usage row as zero (first request of the day, NOT a DB error)", async () => {
    mockUsage.mockResolvedValue({ data: null, error: null });
    openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out).not.toBeNull();
  });
});

describe("rate-limit gate", () => {
  it("returns null and emits event when today's count >= cap", async () => {
    mockPlatformSettings.mockResolvedValue({ data: { value: 100 }, error: null });
    mockUsage.mockResolvedValue({ data: { requests_count: 100 }, error: null });

    const out = await getEmbarkationForecast(OPTS);

    expect(out).toBeNull();
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0]?.[0]).toMatchObject({
      name: "platform.weather_rate_limit_hit",
      data: { cap: 100, today_count: 100, port_id: "miami" },
    });
  });

  it("falls back to default 8000 cap when platform_settings row is missing", async () => {
    mockPlatformSettings.mockResolvedValue({ data: null, error: null });
    mockUsage.mockResolvedValue({ data: { requests_count: 7999 }, error: null });
    openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out).not.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("cache", () => {
  it("returns the cached payload without network when the row is fresh", async () => {
    const cached = {
      payload: {
        high_f: 80,
        low_f: 70,
        precipitation_in: 0.1,
        conditions: "Cached conditions",
        fetched_at: new Date().toISOString(),
      },
      fetched_at: new Date().toISOString(),
    };
    mockCacheSelect.mockResolvedValue({ data: cached, error: null });
    const fetchMock = openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out).toEqual(cached.payload);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("treats rows older than 6h as stale and re-fetches", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    mockCacheSelect.mockResolvedValue({
      data: {
        payload: { high_f: 1, low_f: 1, precipitation_in: 0, conditions: "stale", fetched_at: sevenHoursAgo },
        fetched_at: sevenHoursAgo,
      },
      error: null,
    });
    const fetchMock = openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out?.conditions).toBe("Partly cloudy");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("Open-Meteo fetch + parse", () => {
  it("upserts cache + increments usage on successful response", async () => {
    openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out).toEqual({
      high_f: 82,
      low_f: 71,
      precipitation_in: 0.12,
      conditions: "Partly cloudy",
      fetched_at: expect.any(String),
    });
    expect(mockCacheUpsert).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith("increment_weather_usage");
  });

  it("returns null when Open-Meteo returns non-OK status (don't break the email)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("err", { status: 503 })) as unknown as typeof fetch;

    const out = await getEmbarkationForecast(OPTS);

    expect(out).toBeNull();
    expect(mockCacheUpsert).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns null when response is missing daily.weathercode (defensive)", async () => {
    openMeteoOk({ daily: { temperature_2m_max: [82.4], temperature_2m_min: [71.0], precipitation_sum: [0.1] } });

    const out = await getEmbarkationForecast(OPTS);

    expect(out).toBeNull();
    expect(mockCacheUpsert).not.toHaveBeenCalled();
  });

  it("returns the forecast even when cache upsert fails (best-effort write)", async () => {
    mockCacheUpsert.mockImplementationOnce(async () => ({ error: { message: "tx aborted" } }));
    openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out?.conditions).toBe("Partly cloudy");
  });

  it("returns the forecast even when usage increment fails (best-effort write)", async () => {
    mockRpc.mockImplementationOnce(async () => ({ data: null, error: { message: "rpc unavailable" } }));
    openMeteoOk(VALID_OPEN_METEO_BODY);

    const out = await getEmbarkationForecast(OPTS);

    expect(out?.conditions).toBe("Partly cloudy");
  });

  it("passes lat/lon/date in the URL with imperial units", async () => {
    const fetchMock = openMeteoOk(VALID_OPEN_METEO_BODY);

    await getEmbarkationForecast(OPTS);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("latitude=25.7617");
    expect(calledUrl).toContain("longitude=-80.1918");
    expect(calledUrl).toContain("temperature_unit=fahrenheit");
    expect(calledUrl).toContain("precipitation_unit=inch");
    expect(calledUrl).toContain("start_date=2026-06-10");
    expect(calledUrl).toContain("end_date=2026-06-10");
  });
});

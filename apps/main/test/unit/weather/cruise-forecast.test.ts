// §23.4 — getCruiseForecast preserves stop order and degrades gracefully.
//
// The chart aligns to the cruise timeline, so a failed single-stop fetch
// must NOT collapse the timeline; the stop's slot needs to keep its
// date + port name with null weather fields. These tests pin both the
// success case (every stop populated) and the per-stop failure case.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetEmbarkationForecast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weather/open-meteo", () => ({
  getEmbarkationForecast: mockGetEmbarkationForecast,
}));

import { getCruiseForecast } from "@/lib/weather/cruise-forecast";

const STOPS = [
  { port_id: "miami",   port_name: "Miami, FL",        latitude: 25.7617, longitude: -80.1918, date: "2026-08-28" },
  { port_id: "sea1",    port_name: "At sea",           latitude: 24.0,    longitude: -84.0,    date: "2026-08-29" },
  { port_id: "roatan",  port_name: "Roatán, Honduras", latitude: 16.3,    longitude: -86.5,    date: "2026-08-30" },
];

beforeEach(() => {
  mockGetEmbarkationForecast.mockReset();
});

describe("getCruiseForecast", () => {
  it("returns one entry per stop in stop order", async () => {
    mockGetEmbarkationForecast.mockResolvedValue({
      high_f: 85, low_f: 75, precipitation_in: 0.1, conditions: "Partly cloudy", fetched_at: "x",
    });

    const out = await getCruiseForecast(STOPS);

    expect(out).toHaveLength(3);
    expect(out.map((d) => d.port_name)).toEqual(["Miami, FL", "At sea", "Roatán, Honduras"]);
    expect(out.map((d) => d.date)).toEqual(["2026-08-28", "2026-08-29", "2026-08-30"]);
  });

  it("keeps stop order even when one stop's forecast fails (chart needs the slot)", async () => {
    mockGetEmbarkationForecast
      .mockResolvedValueOnce({ high_f: 85, low_f: 75, precipitation_in: 0, conditions: "Clear", fetched_at: "x" })
      .mockResolvedValueOnce(null) // sea-day fetch fails
      .mockResolvedValueOnce({ high_f: 87, low_f: 76, precipitation_in: 0.2, conditions: "Rain", fetched_at: "x" });

    const out = await getCruiseForecast(STOPS);

    expect(out).toHaveLength(3);
    expect(out[0]?.high_f).toBe(85);
    expect(out[1]).toMatchObject({
      port_name: "At sea",
      date: "2026-08-29",
      high_f: null,
      low_f: null,
      precipitation_in: null,
      conditions: null,
    });
    expect(out[2]?.high_f).toBe(87);
  });

  it("returns an empty array for an empty stop list", async () => {
    const out = await getCruiseForecast([]);
    expect(out).toEqual([]);
    expect(mockGetEmbarkationForecast).not.toHaveBeenCalled();
  });
});

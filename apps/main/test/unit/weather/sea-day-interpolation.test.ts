// #486 — Sea-day interpolation unit tests.

import { describe, expect, it } from "vitest";
import { interpolateSeaDays, type ItineraryDay } from "../../../src/lib/weather/sea-day-interpolation";

// Miami: ~25.8°N, 80.2°W
const MIAMI: Pick<ItineraryDay, "latitude" | "longitude"> = { latitude: 25.8, longitude: -80.2 };
// Roatán: ~16.3°N, 86.6°W
const ROATAN: Pick<ItineraryDay, "latitude" | "longitude"> = { latitude: 16.3, longitude: -86.6 };
// Cozumel: ~20.4°N, 86.9°W
const COZUMEL: Pick<ItineraryDay, "latitude" | "longitude"> = { latitude: 20.4, longitude: -86.9 };

function port(day: number, date: string, name: string, coords: Pick<ItineraryDay, "latitude" | "longitude">): ItineraryDay {
  return { day_number: day, date, port_name: name, ...coords };
}
function sea(day: number, date: string): ItineraryDay {
  return { day_number: day, date, port_name: null, latitude: null, longitude: null };
}

describe("interpolateSeaDays", () => {
  it("sea day between Miami and Roatán → midpoint of those coords", () => {
    const days: ItineraryDay[] = [
      port(1, "2026-04-25", "Miami", MIAMI),
      sea(2, "2026-04-26"),
      port(3, "2026-04-27", "Roatán", ROATAN),
    ];
    const result = interpolateSeaDays(days);
    expect(result).toHaveLength(3);
    const seaDay = result[1]!;
    expect(seaDay.port_name).toBe("At Sea");
    expect(seaDay.date).toBe("2026-04-26");
    // midpoint: (25.8 + 16.3) / 2 = 21.05
    expect(seaDay.latitude).toBeCloseTo(21.05, 4);
    expect(seaDay.longitude).toBeCloseTo((-80.2 + -86.6) / 2, 4);
  });

  it("two sea days between Miami and Roatán → 1/3 and 2/3 along the line", () => {
    const days: ItineraryDay[] = [
      port(1, "2026-04-25", "Miami", MIAMI),
      sea(2, "2026-04-26"),
      sea(3, "2026-04-27"),
      port(4, "2026-04-28", "Roatán", ROATAN),
    ];
    const result = interpolateSeaDays(days);
    expect(result).toHaveLength(4);
    const d1 = result[1]!;
    const d2 = result[2]!;
    // 1/3 and 2/3 of the way from MIAMI to ROATAN
    const latRange = ROATAN.latitude! - MIAMI.latitude!;
    expect(d1.latitude).toBeCloseTo(MIAMI.latitude! + latRange * (1 / 3), 4);
    expect(d2.latitude).toBeCloseTo(MIAMI.latitude! + latRange * (2 / 3), 4);
  });

  it("sea day first (Day 1 is sea) → uses next port's coords exactly", () => {
    const days: ItineraryDay[] = [
      sea(1, "2026-04-25"),
      port(2, "2026-04-26", "Miami", MIAMI),
    ];
    const result = interpolateSeaDays(days);
    expect(result).toHaveLength(2);
    expect(result[0]!.latitude).toBe(MIAMI.latitude);
    expect(result[0]!.longitude).toBe(MIAMI.longitude);
    expect(result[0]!.port_name).toBe("At Sea");
  });

  it("sea day last → uses previous port's coords exactly", () => {
    const days: ItineraryDay[] = [
      port(1, "2026-04-25", "Miami", MIAMI),
      sea(2, "2026-04-26"),
    ];
    const result = interpolateSeaDays(days);
    expect(result).toHaveLength(2);
    expect(result[1]!.latitude).toBe(MIAMI.latitude);
    expect(result[1]!.longitude).toBe(MIAMI.longitude);
  });

  it("all-sea-days input → empty array (no anchors)", () => {
    const days: ItineraryDay[] = [
      sea(1, "2026-04-25"),
      sea(2, "2026-04-26"),
    ];
    expect(interpolateSeaDays(days)).toEqual([]);
  });

  it("empty input → empty array", () => {
    expect(interpolateSeaDays([])).toEqual([]);
  });

  it("port day with real coords → passed through unchanged (identity)", () => {
    const days: ItineraryDay[] = [
      port(1, "2026-04-25", "Cozumel", COZUMEL),
      port(2, "2026-04-26", "Roatán", ROATAN),
    ];
    const result = interpolateSeaDays(days);
    expect(result).toHaveLength(2);
    expect(result[0]!.port_name).toBe("Cozumel");
    expect(result[0]!.latitude).toBe(COZUMEL.latitude);
    expect(result[1]!.port_name).toBe("Roatán");
    expect(result[1]!.latitude).toBe(ROATAN.latitude);
  });

  it("multiple leading sea days all get next port's coords", () => {
    const days: ItineraryDay[] = [
      sea(1, "2026-04-25"),
      sea(2, "2026-04-26"),
      port(3, "2026-04-27", "Miami", MIAMI),
    ];
    const result = interpolateSeaDays(days);
    expect(result).toHaveLength(3);
    expect(result[0]!.latitude).toBe(MIAMI.latitude);
    expect(result[1]!.latitude).toBe(MIAMI.latitude);
  });

  it("sea day port_id is 'sea:{date}' so getCruiseForecast can cache it independently", () => {
    const days: ItineraryDay[] = [
      port(1, "2026-04-25", "Miami", MIAMI),
      sea(2, "2026-04-26"),
      port(3, "2026-04-27", "Roatán", ROATAN),
    ];
    const result = interpolateSeaDays(days);
    expect(result[1]!.port_id).toBe("sea:2026-04-26");
  });
});

// §23.6 — wmoCodeToText covers the codes Open-Meteo actually emits.
// Each test pins a representative code per WMO band so a future edit
// that re-orders or drops a row trips a failure here.

import { describe, it, expect } from "vitest";
import { wmoCodeToText } from "@/lib/weather/wmo-codes";

describe("wmoCodeToText — known bands", () => {
  it("maps clear-sky and partly-cloudy variants", () => {
    expect(wmoCodeToText(0)).toBe("Clear sky");
    expect(wmoCodeToText(2)).toBe("Partly cloudy");
    expect(wmoCodeToText(3)).toBe("Overcast");
  });

  it("maps fog, drizzle, freezing-drizzle bands", () => {
    expect(wmoCodeToText(45)).toBe("Fog");
    expect(wmoCodeToText(53)).toBe("Moderate drizzle");
    expect(wmoCodeToText(56)).toBe("Light freezing drizzle");
  });

  it("maps rain bands incl. freezing-rain", () => {
    expect(wmoCodeToText(63)).toBe("Moderate rain");
    expect(wmoCodeToText(67)).toBe("Heavy freezing rain");
  });

  it("maps snow + showers + thunderstorm bands", () => {
    expect(wmoCodeToText(73)).toBe("Moderate snow");
    expect(wmoCodeToText(82)).toBe("Violent rain showers");
    expect(wmoCodeToText(95)).toBe("Thunderstorm");
    expect(wmoCodeToText(99)).toBe("Thunderstorm with heavy hail");
  });
});

describe("wmoCodeToText — unknown codes", () => {
  it("returns 'Unknown' for codes not in the table (caller decides to omit)", () => {
    expect(wmoCodeToText(7)).toBe("Unknown");
    expect(wmoCodeToText(999)).toBe("Unknown");
    expect(wmoCodeToText(-1)).toBe("Unknown");
  });
});

// §23.4 — Open-Meteo WMO weather-code → human-readable text.
//
// Open-Meteo emits WMO 4677 weather codes (integer) for each forecast day.
// We surface them in PreCruiseT1 as short phrases. Mapping table is
// authoritative source: https://open-meteo.com/en/docs (Weathercode column).
//
// Unknown codes return "Unknown" rather than throwing — the caller can
// decide to omit the section. (Forecast data is best-effort; an unknown
// code shouldn't break the email.)

const WMO_CODE_TEXT: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with light hail",
  99: "Thunderstorm with heavy hail",
};

export function wmoCodeToText(code: number): string {
  return WMO_CODE_TEXT[code] ?? "Unknown";
}

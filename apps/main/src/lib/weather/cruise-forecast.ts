// §23.4 — Multi-day cruise forecast helper.
//
// Wraps the single-port `getEmbarkationForecast` (production helper with
// cache + rate-limit gate) for the "full-cruise weather strip" rendered
// in T-7 and T-1 emails. One Open-Meteo call per stop, ordered to
// preserve the cruise timeline (at-sea days and failed-fetch days keep
// their slot with null fields so the chart's day columns line up).
//
// Open-Meteo's forecast horizon is 16 days. For sailings further out,
// the helper returns null fields for any stop beyond the horizon; the
// chart renders those columns as "Forecast pending."

import { getEmbarkationForecast } from "./open-meteo";

export interface CruiseStop {
  port_id: string;
  port_name: string;
  latitude: number;
  longitude: number;
  date: string;
}

export interface DailyForecast {
  date: string;
  port_name: string;
  high_f: number | null;
  low_f: number | null;
  precipitation_in: number | null;
  conditions: string | null;
}

export async function getCruiseForecast(
  stops: CruiseStop[],
): Promise<DailyForecast[]> {
  return Promise.all(
    stops.map(async (stop): Promise<DailyForecast> => {
      const f = await getEmbarkationForecast({
        port_id: stop.port_id,
        latitude: stop.latitude,
        longitude: stop.longitude,
        date: stop.date,
      });
      if (!f) {
        return {
          date: stop.date,
          port_name: stop.port_name,
          high_f: null,
          low_f: null,
          precipitation_in: null,
          conditions: null,
        };
      }
      return {
        date: stop.date,
        port_name: stop.port_name,
        high_f: f.high_f,
        low_f: f.low_f,
        precipitation_in: f.precipitation_in,
        conditions: f.conditions,
      };
    }),
  );
}

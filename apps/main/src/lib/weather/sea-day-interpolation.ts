// #486 — Sea-day coordinate interpolation.
//
// For itinerary days that have no lat/lon (at-sea days, or days where the
// port-lookup returned null), approximate the vessel's position as the
// linear midpoint of the nearest preceding and following ported days.
//
// Returns only the days for which we can resolve a position — days
// where there are no bounding ports at all (pure-sea itinerary) are
// dropped and the caller receives an empty array.

import type { CruiseStop } from "./cruise-forecast";

export interface ItineraryDay {
  day_number: number;
  date: string;
  port_name: string | null;
  latitude: number | null;
  longitude: number | null;
}

type Segment =
  | { kind: "port"; day: ItineraryDay }
  | { kind: "sea"; days: ItineraryDay[] };

interface BoundPort { lat: number; lon: number }

export function interpolateSeaDays(days: ItineraryDay[]): CruiseStop[] {
  if (days.length === 0) return [];

  // Build segments: runs of sea days separated by port days.
  // A port day = has both lat and lon. Sea day = missing either.
  const segments: Segment[] = [];
  let seaRun: ItineraryDay[] = [];

  for (const day of days) {
    if (day.latitude !== null && day.longitude !== null) {
      if (seaRun.length > 0) {
        segments.push({ kind: "sea", days: seaRun });
        seaRun = [];
      }
      segments.push({ kind: "port", day });
    } else {
      seaRun.push(day);
    }
  }
  if (seaRun.length > 0) segments.push({ kind: "sea", days: seaRun });

  // All sea days — nothing to anchor the interpolation.
  if (!segments.some((s) => s.kind === "port")) return [];

  const result: CruiseStop[] = [];

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]!;

    if (seg.kind === "port") {
      result.push({
        port_id: `port:${seg.day.date}:${seg.day.port_name ?? "unknown"}`,
        port_name: seg.day.port_name ?? "Port",
        latitude: seg.day.latitude!,
        longitude: seg.day.longitude!,
        date: seg.day.date,
      });
      continue;
    }

    // Sea segment — find the nearest bounding port coords.
    const prev = findPrevPort(segments, si);
    const next = findNextPort(segments, si);
    const n = seg.days.length;

    for (let k = 0; k < n; k++) {
      const day = seg.days[k]!;
      let lat: number;
      let lon: number;

      if (prev !== null && next !== null) {
        // Proportional: (k+1)/(n+1) of the way from prev to next.
        const frac = (k + 1) / (n + 1);
        lat = prev.lat + frac * (next.lat - prev.lat);
        lon = prev.lon + frac * (next.lon - prev.lon);
      } else {
        // Leading or trailing tail — use the one anchor we have.
        const anchor = (prev ?? next)!;
        lat = anchor.lat;
        lon = anchor.lon;
      }

      result.push({
        port_id: `sea:${day.date}`,
        port_name: "At Sea",
        latitude: lat,
        longitude: lon,
        date: day.date,
      });
    }
  }

  return result;
}

function findPrevPort(segments: Segment[], si: number): BoundPort | null {
  for (let i = si - 1; i >= 0; i--) {
    const s = segments[i]!;
    if (s.kind === "port") return { lat: s.day.latitude!, lon: s.day.longitude! };
  }
  return null;
}

function findNextPort(segments: Segment[], si: number): BoundPort | null {
  for (let i = si + 1; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.kind === "port") return { lat: s.day.latitude!, lon: s.day.longitude! };
  }
  return null;
}

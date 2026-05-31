// #487 — Fetch sailing itinerary from the RAG service for email enrichment.
//
// Returns ports_of_call (for region classification + hero image) and
// day_by_day (for sea-day interpolation + multi-day forecast chart).
// Both fields are null-safe: ports_of_call falls back to [] if the
// sailing isn't in the RAG yet; day_by_day is null for Apify-sourced rows.

import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";

export interface SailingDay {
  day_number: number;
  date: string;
  port_name: string | null;
}

export interface SailingItinerary {
  ports_of_call: string[];
  days: SailingDay[];
}

export async function getSailingItinerary(args: {
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
}): Promise<SailingItinerary | null> {
  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) return null;

  let jwt: string;
  try {
    jwt = await signServiceJwt({
      tenant_id: PLATFORM_SENTINEL_TENANT_ID,
      scope: "read",
      service_identifier: "platform-admin",
    });
  } catch {
    return null;
  }

  const params = new URLSearchParams({
    cruise_line: args.cruise_line,
    ship: args.ship_name,
    departure_date: args.sailing_date,
  });

  let res: Response;
  try {
    res = await fetch(`${ragUrl}/api/itinerary?${params}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch {
    return null;
  }

  if (!res.ok || res.status === 404) return null;

  type ItineraryJson = { ports_of_call?: string[]; day_by_day?: SailingDay[] | null };
  let json: ItineraryJson | null = null;
  try { json = (await res.json()) as ItineraryJson; } catch { return null; }
  if (!json) return null;

  return {
    ports_of_call: json.ports_of_call ?? [],
    days: json.day_by_day ?? [],
  };
}

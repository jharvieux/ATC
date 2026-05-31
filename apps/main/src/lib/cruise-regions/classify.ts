// #486 — Region resolver for destination-image and weather-forecast lookups.
//
// Primary: normalize a CruiseMapper region string (extracted from the cruise
// title by the sailing/sailing-list parsers) into our DestinationRegion enum.
//
// Backup: classify by the first port of call — static lookup, deterministic.
//
// Combined: resolveDestinationRegion() is the caller-facing entry point.

import type { DestinationRegion } from "./destination-images";

// startsWith handles "Western Caribbean", "Eastern Caribbean", etc. without
// requiring every combination to be listed explicitly.
const CM_MAP: Array<[string[], DestinationRegion]> = [
  [["western caribbean", "eastern caribbean", "southern caribbean", "caribbean"], "caribbean"],
  [["bahamas"], "bahamas"],
  [["alaska"], "alaska"],
  [["western mediterranean", "eastern mediterranean", "mediterranean"], "mediterranean"],
  [["norwegian fjords", "northern europe", "baltic"], "northern_europe"],
  [["mexican riviera", "mexico"], "mexican_riviera"],
  [["hawaiian islands", "hawaii"], "hawaii"],
  [["bermuda"], "bermuda"],
  [["southeast asia", "far east", "japan", "asia"], "asia"],
  [["french polynesia", "tahiti", "south pacific"], "south_pacific"],
  [["repositioning", "transatlantic"], "transatlantic"],
];

const SUFFIX_RE = /\s+(cruises?|voyages?|sailings?)$/i;

export function normalizeCruiseMapperRegion(
  raw: string | null | undefined,
): DestinationRegion | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(SUFFIX_RE, "").toLowerCase();
  if (!normalized) return null;
  for (const [keys, region] of CM_MAP) {
    for (const key of keys) {
      if (normalized === key || normalized.startsWith(key + " ")) return region;
    }
  }
  return null;
}

// ~60 first-stop → region entries covering major NA departure/call ports.
const FIRST_STOP_REGION: Record<string, DestinationRegion> = {
  "Roatán": "caribbean", "Roatan": "caribbean",
  "Cozumel": "caribbean", "Costa Maya": "caribbean",
  "Grand Cayman": "caribbean", "St. Thomas": "caribbean",
  "St. Maarten": "caribbean", "Sint Maarten": "caribbean",
  "St. Lucia": "caribbean", "Barbados": "caribbean",
  "Aruba": "caribbean", "Curacao": "caribbean", "Curaçao": "caribbean",
  "Falmouth": "caribbean", "Ocho Rios": "caribbean", "Montego Bay": "caribbean",
  "Belize City": "caribbean", "Harvest Caye": "caribbean",
  "Amber Cove": "caribbean", "La Romana": "caribbean",
  "Bridgetown": "caribbean", "Castries": "caribbean",
  "San Juan": "caribbean", "Puerto Plata": "caribbean",
  "Nassau": "bahamas", "Freeport": "bahamas",
  "CocoCay": "bahamas", "Princess Cays": "bahamas",
  "Half Moon Cay": "bahamas", "Ocean Cay": "bahamas",
  "Bimini": "bahamas",
  "Juneau": "alaska", "Skagway": "alaska",
  "Ketchikan": "alaska", "Sitka": "alaska",
  "Icy Strait Point": "alaska", "Glacier Bay": "alaska",
  "Hubbard Glacier": "alaska", "Whittier": "alaska",
  "Seward": "alaska", "Haines": "alaska",
  "Barcelona": "mediterranean", "Civitavecchia": "mediterranean",
  "Naples": "mediterranean", "Livorno": "mediterranean",
  "Venice": "mediterranean", "Santorini": "mediterranean",
  "Mykonos": "mediterranean", "Piraeus": "mediterranean",
  "Athens": "mediterranean", "Dubrovnik": "mediterranean",
  "Marseille": "mediterranean", "Valletta": "mediterranean",
  "Kotor": "mediterranean", "Palermo": "mediterranean",
  "Messina": "mediterranean", "Split": "mediterranean",
  "Copenhagen": "northern_europe", "Stockholm": "northern_europe",
  "Oslo": "northern_europe", "Bergen": "northern_europe",
  "Geiranger": "northern_europe", "Tallinn": "northern_europe",
  "Helsinki": "northern_europe", "Reykjavik": "northern_europe",
  "Amsterdam": "northern_europe", "Hamburg": "northern_europe",
  "Alesund": "northern_europe", "Ålesund": "northern_europe",
  "Cabo San Lucas": "mexican_riviera", "Mazatlán": "mexican_riviera",
  "Mazatlan": "mexican_riviera", "Puerto Vallarta": "mexican_riviera",
  "Ensenada": "mexican_riviera", "Manzanillo": "mexican_riviera",
  "Honolulu": "hawaii", "Hilo": "hawaii",
  "Kona": "hawaii", "Kahului": "hawaii",
  "Nawiliwili": "hawaii",
  "Bermuda": "bermuda", "Hamilton": "bermuda",
  "King's Wharf": "bermuda", "St. George's": "bermuda",
  "Singapore": "asia", "Hong Kong": "asia",
  "Shanghai": "asia", "Yokohama": "asia",
  "Laem Chabang": "asia", "Ho Chi Minh City": "asia",
  "Bali": "asia", "Osaka": "asia", "Tokyo": "asia",
  "Bora Bora": "south_pacific", "Papeete": "south_pacific",
  "Moorea": "south_pacific", "Fiji": "south_pacific",
  "Lautoka": "south_pacific", "Sydney": "south_pacific",
  "Auckland": "south_pacific",
};

// Use the first stop we RECOGNIZE as a destination port — departure/embarkation
// ports that aren't in the table (e.g. Miami, Fort Lauderdale) are naturally
// skipped, so `["Miami", "Bermuda"]` correctly classifies as bermuda.
export function classifyByFirstStop(portsOfCall: string[]): DestinationRegion {
  for (const p of portsOfCall) {
    const region = FIRST_STOP_REGION[p];
    if (region !== undefined) return region;
  }
  return "other";
}

export function resolveDestinationRegion(args: {
  cruisemapper_region?: string | null;
  ports_of_call: string[];
}): DestinationRegion {
  const fromCm = normalizeCruiseMapperRegion(args.cruisemapper_region);
  if (fromCm !== null) return fromCm;
  return classifyByFirstStop(args.ports_of_call);
}

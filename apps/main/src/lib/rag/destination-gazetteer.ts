// §21 — Destination → (region terms, port tokens) gazetteer for region_lookup.
//
// The itineraries table stores a `region` label (e.g. "Caribbean", "Alaska") but
// it is UNSET on a large share of rows — ~96% of Australian-port sailings carry a
// NULL region, for instance. So matching a named area to inventory needs BOTH the
// region label AND the area's major cruise ports (a port match catches the
// NULL-region rows). A country/area name like "Australia" never appears inside a
// port field (which holds "Sydney", "Brisbane"…), so we expand it here.
//
// Only entries whose NAME won't already appear in the data need expansion. For a
// region that IS the region-column label (e.g. "Caribbean") or a literal port
// ("Barcelona"), the caller also passes the raw phrase through as both a region
// term and a port term, so the long tail works without a gazetteer entry. This
// map exists for the country/area → ports expansion the raw phrase can't do.

export interface LookupTerms {
  regionTerms: string[];
  portTerms: string[];
}

// Shared origin term objects (referenced by several synonym keys below).
const US_ORIGIN: LookupTerms = {
  regionTerms: ["United States"],
  portTerms: [
    // East / Gulf coast
    "Miami", "Fort Lauderdale", "Port Canaveral", "Tampa", "Jacksonville", "Galveston", "New Orleans", "Mobile",
    // "Cape Liberty Bayonne" is a single space-joined segment in the data; the
    // combined token recovers it under segment-exact matching (#1466).
    "New York", "Cape Liberty Bayonne", "Cape Liberty", "Bayonne", "Baltimore", "Boston", "Norfolk", "Charleston",
    // West coast + Alaska embarkation
    "Los Angeles", "Long Beach", "San Diego", "San Francisco", "Seattle", "Seward", "Whittier", "Anchorage",
    // Hawaii + US territories
    "Honolulu", "San Juan",
  ],
};
const UK_ORIGIN: LookupTerms = {
  regionTerms: ["United Kingdom"],
  portTerms: ["Southampton", "Dover", "London", "Liverpool", "Greenock", "Edinburgh"],
};

// Keys are normalized (lowercased, trimmed) destination phrases and common
// synonyms. Region terms match itineraries.region (ILIKE, substring); port terms
// match departure_port / ports_of_call (ILIKE, substring) — so "Sydney" also
// catches "Sydney, Australia".
const GAZETTEER: Record<string, LookupTerms> = {
  australia: {
    // NOTE(collision): "Sydney" is needed here — 406 Australian sailings depart a
    // bare departure_port "Sydney" and most carry a NULL region, so they are only
    // findable by this port token. But "Sydney" is a substring of the Canadian
    // "Sydney NS, Nova Scotia" (173 ports_of_call rows), which an OR-based ILIKE
    // can't exclude, so an Australia query bleeds in those Canadian sailings.
    // Cleanly fixing this needs a structured port→country field — TODO(#1466).
    regionTerms: ["Australia"],
    portTerms: ["Sydney", "Brisbane", "Melbourne", "Perth", "Adelaide", "Cairns", "Fremantle", "Hobart", "Darwin"],
  },
  "new zealand": {
    regionTerms: ["New Zealand"],
    portTerms: ["Auckland", "Wellington", "Christchurch", "Dunedin", "Tauranga"],
  },
  "australia and new zealand": {
    regionTerms: ["Australia", "New Zealand"],
    portTerms: ["Sydney", "Brisbane", "Melbourne", "Auckland", "Wellington"],
  },
  alaska: {
    regionTerms: ["Alaska"],
    portTerms: ["Seattle", "Vancouver", "Juneau", "Ketchikan", "Skagway", "Seward", "Whittier"],
  },
  caribbean: {
    regionTerms: ["Caribbean"],
    portTerms: ["Miami", "Fort Lauderdale", "Port Canaveral", "San Juan", "Cozumel", "Nassau"],
  },
  mediterranean: {
    regionTerms: ["Mediterranean"],
    portTerms: ["Barcelona", "Rome", "Civitavecchia", "Naples", "Venice", "Athens", "Piraeus", "Marseille"],
  },
  "greek isles": {
    regionTerms: ["Greek Isles"],
    portTerms: ["Athens", "Piraeus", "Santorini", "Mykonos", "Rhodes"],
  },
  greece: {
    regionTerms: ["Greek Isles"],
    portTerms: ["Athens", "Piraeus", "Santorini", "Mykonos", "Rhodes"],
  },
  hawaii: {
    regionTerms: ["Hawaii"],
    portTerms: ["Honolulu", "Maui", "Kahului", "Hilo", "Kona"],
  },
  "northern europe": {
    regionTerms: ["Northern Europe", "Baltic"],
    portTerms: ["Copenhagen", "Stockholm", "Southampton", "Amsterdam", "Hamburg"],
  },
  baltic: {
    regionTerms: ["Baltic", "Northern Europe"],
    portTerms: ["Copenhagen", "Stockholm", "Helsinki", "Tallinn", "Gdansk"],
  },
  "norwegian fjords": {
    regionTerms: ["Norwegian Fjords"],
    portTerms: ["Bergen", "Oslo", "Stavanger", "Geiranger", "Flam"],
  },
  norway: {
    regionTerms: ["Norwegian Fjords"],
    portTerms: ["Bergen", "Oslo", "Stavanger", "Geiranger", "Flam"],
  },
  bahamas: {
    regionTerms: ["Bahamas"],
    portTerms: ["Nassau", "Freeport", "Miami", "Port Canaveral"],
  },
  bermuda: {
    regionTerms: ["Bermuda"],
    portTerms: ["Hamilton", "Kings Wharf", "St George"],
  },
  "south america": {
    regionTerms: ["South America"],
    portTerms: ["Buenos Aires", "Santiago", "Valparaiso", "Rio de Janeiro", "Lima", "Callao"],
  },
  antarctica: {
    regionTerms: ["Antarctica"],
    portTerms: ["Ushuaia", "Buenos Aires", "Punta Arenas"],
  },
  "mexican riviera": {
    regionTerms: ["Mexican Riviera", "Mexico"],
    portTerms: ["Los Angeles", "San Diego", "Cabo San Lucas", "Puerto Vallarta", "Mazatlan", "Ensenada"],
  },
  mexico: {
    regionTerms: ["Mexico", "Mexican Riviera"],
    portTerms: ["Cabo San Lucas", "Puerto Vallarta", "Cozumel", "Ensenada", "Mazatlan", "Progreso", "Costa Maya"],
  },
  japan: {
    regionTerms: ["Asia"],
    portTerms: ["Tokyo", "Yokohama", "Osaka", "Kobe", "Nagasaki"],
  },
  asia: {
    regionTerms: ["Asia"],
    portTerms: ["Singapore", "Tokyo", "Yokohama", "Hong Kong", "Shanghai", "Bangkok"],
  },
  canada: {
    // "Sydney NS" (Nova Scotia) is a real Canadian port but collides with Sydney,
    // Australia under substring matching — see the note on the `australia` entry
    // and TODO(#1466). Matched here as "Sydney NS" (the Canadian form) so a Canada
    // query catches it; the Australia-side bleed is the unsolved direction.
    regionTerms: ["Canada", "New England"],
    portTerms: ["Vancouver", "Quebec", "Montreal", "Halifax", "Saint John", "Victoria", "Charlottetown", "Saguenay", "Sydney NS"],
  },
  "new england": {
    regionTerms: ["New England", "Canada"],
    portTerms: ["Boston", "New York", "Bar Harbor", "Portland", "Halifax"],
  },

  // ── Europe: a bare "Europe" only matches the literal region='Europe' rows
  // (~11% of real European inventory). Fan it out to the European sub-regions
  // AND the major embarkation ports so it reaches Mediterranean / Northern
  // Europe / Greek Isles / Fjords / Baltic sailings (incl. the NULL-region ones).
  europe: {
    regionTerms: ["Europe", "Mediterranean", "Northern Europe", "Greek Isles", "Norwegian Fjords", "Baltic"],
    portTerms: ["Barcelona", "Civitavecchia", "Rome", "Venice", "Naples", "Genoa", "Marseille", "Athens", "Piraeus", "Southampton", "Amsterdam", "Copenhagen", "Stockholm", "Hamburg", "Lisbon", "Bergen"],
  },
  // Individual European countries are neither region values nor ports (ports are
  // cities), so they need explicit city expansion. Port names are substrings, so
  // "Rome" also catches "Civitavecchia-Rome". regionTerms point at the cruise
  // region the country sits in.
  italy: {
    regionTerms: ["Mediterranean"],
    portTerms: ["Rome", "Civitavecchia", "Venice", "Naples", "Genoa", "Trieste", "Bari", "Palermo", "Livorno"],
  },
  spain: {
    regionTerms: ["Mediterranean"],
    portTerms: ["Barcelona", "Malaga", "Cadiz", "Valencia", "Palma de Mallorca", "Bilbao", "Las Palmas"],
  },
  france: {
    regionTerms: ["Mediterranean"],
    portTerms: ["Marseille", "Le Havre", "Nice", "Villefranche", "Cannes", "Bordeaux", "Toulon"],
  },
  portugal: {
    regionTerms: ["Mediterranean", "Transatlantic"],
    portTerms: ["Lisbon", "Porto", "Funchal"],
  },
  germany: {
    regionTerms: ["Northern Europe", "Baltic"],
    portTerms: ["Hamburg", "Kiel", "Warnemunde", "Rostock", "Bremerhaven"],
  },
  netherlands: {
    regionTerms: ["Northern Europe"],
    portTerms: ["Amsterdam", "Rotterdam"],
  },
  scandinavia: {
    regionTerms: ["Northern Europe", "Baltic", "Norwegian Fjords"],
    portTerms: ["Copenhagen", "Stockholm", "Oslo", "Bergen", "Helsinki", "Gothenburg"],
  },
  iceland: {
    regionTerms: ["Northern Europe"],
    portTerms: ["Reykjavik", "Akureyri"],
  },

  // ── Origin countries/areas (used to expand a departure origin like "the US"
  // to its major embarkation ports). regionTerms are unused for origin matching
  // (departure_port holds city names), but kept for the shared shape. The
  // synonym keys all point at the same shared term object.
  "united states": US_ORIGIN,
  usa: US_ORIGIN,
  "the us": US_ORIGIN,
  "united kingdom": UK_ORIGIN,
  uk: UK_ORIGIN,
};

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

// Expand a place phrase to the port tokens used for an ORIGIN (departure)
// constraint. A country/area resolves to its major embarkation ports via the
// gazetteer; a literal port name passes through unchanged. Region labels are
// dropped (departure_port holds city names, not region labels).
export function resolveOriginPortTerms(places: string[]): string[] {
  const portTerms = new Set<string>();
  for (const place of places) {
    const phrase = place.trim();
    if (!phrase) continue;
    portTerms.add(phrase);
    const hit = GAZETTEER[normalize(phrase)];
    if (hit) for (const p of hit.portTerms) portTerms.add(p);
  }
  return [...portTerms];
}

// Resolve extracted DESTINATIONS to the region/port term sets a region_lookup
// matches against. The raw destination phrase is always included as BOTH a region
// term and a port term so the long tail (literal region labels and literal port
// names) works without a gazetteer entry; gazetteer entries add the country/area →
// major-ports expansion the raw phrase can't do. (Departure origins are handled
// separately by resolveOriginPortTerms — they constrain origin, not destination.)
export function resolveDestinationToLookupTerms(destinations: string[]): LookupTerms {
  const regionTerms = new Set<string>();
  const portTerms = new Set<string>();

  for (const dest of destinations) {
    const phrase = dest.trim();
    if (!phrase) continue;
    regionTerms.add(phrase);
    portTerms.add(phrase);
    const hit = GAZETTEER[normalize(phrase)];
    if (hit) {
      for (const r of hit.regionTerms) regionTerms.add(r);
      for (const p of hit.portTerms) portTerms.add(p);
    }
  }

  return { regionTerms: [...regionTerms], portTerms: [...portTerms] };
}

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

// Keys are normalized (lowercased, trimmed) destination phrases and common
// synonyms. Region terms match itineraries.region (ILIKE, substring); port terms
// match departure_port / ports_of_call (ILIKE, substring) — so "Sydney" also
// catches "Sydney, Australia".
const GAZETTEER: Record<string, LookupTerms> = {
  australia: {
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
    portTerms: ["Cabo San Lucas", "Puerto Vallarta", "Cozumel", "Ensenada"],
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
    regionTerms: ["Canada", "New England"],
    portTerms: ["Vancouver", "Quebec", "Montreal", "Halifax", "Saint John"],
  },
  "new england": {
    regionTerms: ["New England", "Canada"],
    portTerms: ["Boston", "New York", "Bar Harbor", "Portland", "Halifax"],
  },
};

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

// Resolve extracted destinations + departure ports to the region/port term sets a
// region_lookup matches against. The raw destination phrase is always included as
// BOTH a region term and a port term so the long tail (literal region labels and
// literal port names) works without a gazetteer entry; gazetteer entries add the
// country/area → major-ports expansion the raw phrase can't do.
export function resolveDestinationToLookupTerms(
  destinations: string[],
  departurePorts: string[],
): LookupTerms {
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

  for (const port of departurePorts) {
    const phrase = port.trim();
    if (phrase) portTerms.add(phrase);
  }

  return { regionTerms: [...regionTerms], portTerms: [...portTerms] };
}

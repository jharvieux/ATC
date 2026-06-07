// BP35 §33.4 — itinerary mapper unit tests.

import { describe, expect, it } from "vitest";
import { mapItinerary, mapSailing, mapSailingListItem, chunkSourceIdentifier, type CruiseMapperItineraryItem } from "../../../src/lib/external/cruisemapper/itinerary-mapper";
import type { ParsedSailing } from "../../../src/lib/external/cruisemapper/parsers/sailing-parser";
import type { SailingListItem } from "../../../src/lib/external/cruisemapper/parsers/sailing-list-parser";

const BASE: CruiseMapperItineraryItem = {
  cruiseLine: "Royal Caribbean",
  ship: "Symphony of the Seas",
  departureDate: "2026-08-15",
  departurePort: "Miami",
  durationNights: 7,
  portsOfCall: ["Cozumel", "Roatán", "Costa Maya"],
  region: "Caribbean",
  startingPriceUsd: 649,
  sourceUrl: "https://www.cruisemapper.com/cruise-itinerary/123",
};

describe("mapItinerary", () => {
  it("maps a full record to both cache quote and RAG text", () => {
    const out = mapItinerary(BASE);
    expect(out).not.toBeNull();
    if (!out) return;

    expect(out.key.line).toBe("RCL");
    expect(out.key.ship).toBe("Symphony of the Seas");
    expect(out.key.sailDate).toBe("2026-08-15");
    expect(out.key.durationNights).toBe(7);
    expect(out.cacheQuote).not.toBeNull();
    expect(out.cacheQuote!.cabinPrices.interior?.amount).toBe(649);
    expect(out.text).toContain("Symphony of the Seas");
    expect(out.text).toContain("Cozumel");
    expect(out.text).toContain("$649");
    expect(out.text).toContain("RCL");
  });

  it("returns null when required fields are missing", () => {
    expect(mapItinerary({ ...BASE, ship: undefined })).toBeNull();
    expect(mapItinerary({ ...BASE, departureDate: undefined })).toBeNull();
    expect(mapItinerary({ ...BASE, durationNights: undefined })).toBeNull();
  });

  it("returns null when departureDate isn't ISO YYYY-MM-DD", () => {
    expect(mapItinerary({ ...BASE, departureDate: "08/15/2026" })).toBeNull();
  });

  it("falls back to BCK (never dropped) when the cruise line is unrecognized", () => {
    // The 2026-06-06 gap: unknown lines used to return null and get silently
    // dropped. They must now ingest under the aggregator code instead.
    expect(mapItinerary({ ...BASE, cruiseLine: "Some Made-Up Cruise Line" })!.key.line).toBe("BCK");
  });

  it("returns null only when the cruise line is empty/missing", () => {
    expect(mapItinerary({ ...BASE, cruiseLine: "" })).toBeNull();
    expect(mapItinerary({ ...BASE, cruiseLine: undefined })).toBeNull();
  });

  it("omits cache quote when no starting price provided", () => {
    const out = mapItinerary({ ...BASE, startingPriceUsd: undefined });
    expect(out).not.toBeNull();
    expect(out!.cacheQuote).toBeNull();
    expect(out!.text).not.toContain("$");
  });

  it("text is deterministic for the same input (content-hash idempotency)", () => {
    const a = mapItinerary(BASE)!.text;
    const b = mapItinerary(BASE)!.text;
    expect(a).toBe(b);
  });

  it("text changes when ports of call change (so re-ingest writes a new chunk)", () => {
    const a = mapItinerary(BASE)!.text;
    const b = mapItinerary({ ...BASE, portsOfCall: ["Cozumel", "Roatán"] })!.text;
    expect(a).not.toBe(b);
  });

  it("normalizes mainstream + luxury long-form line names to short codes", () => {
    expect(mapItinerary({ ...BASE, cruiseLine: "Norwegian" })!.key.line).toBe("NCL");
    // Regression: "Carnival Cruise Line" is the actual CruiseMapper label and
    // used to miss the exact-match map (only "Carnival" was listed) -> 31 ships dropped.
    expect(mapItinerary({ ...BASE, cruiseLine: "Carnival Cruise Line" })!.key.line).toBe("CCL");
    expect(mapItinerary({ ...BASE, cruiseLine: "Princess Cruises" })!.key.line).toBe("PCL");
    expect(mapItinerary({ ...BASE, cruiseLine: "MSC" })!.key.line).toBe("MSC");
    expect(mapItinerary({ ...BASE, cruiseLine: "Viking Ocean (Viking Cruises)" })!.key.line).toBe("VIK");
    expect(mapItinerary({ ...BASE, cruiseLine: "Oceania Cruises" })!.key.line).toBe("OCE");
    expect(mapItinerary({ ...BASE, cruiseLine: "Silversea Expeditions (Silversea Cruises)" })!.key.line).toBe("SIL");
    expect(mapItinerary({ ...BASE, cruiseLine: "Regent Seven Seas Cruises" })!.key.line).toBe("RSS");
    expect(mapItinerary({ ...BASE, cruiseLine: "Seabourn Cruises" })!.key.line).toBe("SBN");
    expect(mapItinerary({ ...BASE, cruiseLine: "Windstar Cruises" })!.key.line).toBe("WST");
    expect(mapItinerary({ ...BASE, cruiseLine: "Azamara Cruises" })!.key.line).toBe("AZA");
    expect(mapItinerary({ ...BASE, cruiseLine: "Cunard" })!.key.line).toBe("CUN");
    expect(mapItinerary({ ...BASE, cruiseLine: "Virgin Voyages" })!.key.line).toBe("VVY");
    expect(mapItinerary({ ...BASE, cruiseLine: "P&O UK (P&O Cruises)" })!.key.line).toBe("PNO");
    // Sub-brands resolve to their parent line.
    expect(mapItinerary({ ...BASE, cruiseLine: "Galapagos (Celebrity Cruises)" })!.key.line).toBe("CEL");
    expect(mapItinerary({ ...BASE, cruiseLine: "MSC Explora Journeys" })!.key.line).toBe("MSC");
  });

  it("labels cache quote source as 'apify' (Apify actor path, not DIY)", () => {
    const out = mapItinerary(BASE);
    expect(out!.cacheQuote!.source).toBe("apify");
  });
});

const BASE_PARSED_SAILING: ParsedSailing = {
  cruise_line: "Norwegian Cruise Line",
  ship_name: "Norwegian Bliss",
  ship_slug: "norwegian-bliss",
  departure_date: "2026-04-25",
  return_date: "2026-05-02",
  duration_nights: 7,
  departure_port: "Seattle",
  ports_of_call: ["Juneau", "Ketchikan", "Victoria"],
  itinerary: [
    { day_number: 1, date: "2026-04-25", port_name: "Seattle", arrival_time: null, departure_time: "17:00" },
    { day_number: 2, date: "2026-04-26", port_name: null, arrival_time: null, departure_time: null },
    { day_number: 7, date: "2026-05-01", port_name: "Victoria", arrival_time: "07:00", departure_time: "14:00" },
  ],
  region: "Alaska",
  starting_price_usd: 789,
  sailing_slug: "norwegian-bliss-2026-04-25",
  source_url: "https://www.cruisemapper.com/ships/NorwegianBliss-1234",
  text: "Norwegian Cruise Line's Norwegian Bliss departs Seattle on 2026-04-25 for a 7-night cruise (Alaska) visiting Juneau, Ketchikan, Victoria. Starting price $789.",
};

describe("mapSailing", () => {
  it("maps a ParsedSailing with price to MappedItinerary with diy_cruisemapper source", () => {
    const out = mapSailing(BASE_PARSED_SAILING);
    expect(out).not.toBeNull();
    expect(out!.key.line).toBe("NCL");
    expect(out!.key.ship).toBe("Norwegian Bliss");
    expect(out!.key.sailDate).toBe("2026-04-25");
    expect(out!.key.departurePort).toBe("Seattle");
    expect(out!.cacheQuote).not.toBeNull();
    expect(out!.cacheQuote!.source).toBe("diy_cruisemapper");
    expect(out!.cacheQuote!.cabinPrices.interior?.amount).toBe(789);
    expect(out!.dayByDay).toHaveLength(3);
    expect(out!.region).toBe("Alaska");
    expect(out!.portsOfCall).toEqual(["Juneau", "Ketchikan", "Victoria"]);
  });

  it("falls back to BCK (never dropped) for an unrecognized line; null only when empty", () => {
    expect(mapSailing({ ...BASE_PARSED_SAILING, cruise_line: "Unknown Cruises" })!.key.line).toBe("BCK");
    expect(mapSailing({ ...BASE_PARSED_SAILING, cruise_line: null })).toBeNull();
  });

  it("omits cache quote when no starting price", () => {
    const out = mapSailing({ ...BASE_PARSED_SAILING, starting_price_usd: null });
    expect(out).not.toBeNull();
    expect(out!.cacheQuote).toBeNull();
  });

  it("propagates the full day-by-day array (not null) for DIY parsed sailings", () => {
    const out = mapSailing(BASE_PARSED_SAILING);
    expect(out!.dayByDay).not.toBeNull();
    expect(out!.dayByDay!.find((d) => d.port_name === null)).toBeDefined(); // sea day exists
  });

  it("uses the ParsedSailing.text verbatim for RAG determinism", () => {
    const out = mapSailing(BASE_PARSED_SAILING);
    expect(out!.text).toBe(BASE_PARSED_SAILING.text);
  });
});

const BASE_LIST_ITEM: SailingListItem = {
  data_row_id: "4869927",
  title: "7 days, round-trip Alaska Round-trip Seattle Juneau, Ketchikan Victoria",
  departure_date: "2026-04-25",
  departure_port: "Seattle",
  duration_nights: 7,
  starting_price_usd: 789,
  region: "Alaska",
};

describe("mapSailingListItem", () => {
  it("maps a list item with price to MappedItinerary with diy_cruisemapper source", () => {
    const out = mapSailingListItem(BASE_LIST_ITEM, "Norwegian Bliss", "Norwegian Cruise Line");
    expect(out).not.toBeNull();
    expect(out!.key.line).toBe("NCL");
    expect(out!.key.ship).toBe("Norwegian Bliss");
    expect(out!.key.sailDate).toBe("2026-04-25");
    expect(out!.cacheQuote).not.toBeNull();
    expect(out!.cacheQuote!.source).toBe("diy_cruisemapper");
    expect(out!.cacheQuote!.cabinPrices.interior?.amount).toBe(789);
  });

  it("falls back to BCK (never dropped) for an unrecognized line; null only when empty", () => {
    expect(mapSailingListItem(BASE_LIST_ITEM, "Norwegian Bliss", "Unknown Cruises")!.key.line).toBe("BCK");
    expect(mapSailingListItem(BASE_LIST_ITEM, "Norwegian Bliss", "")).toBeNull();
  });

  it("omits cache quote when no starting price", () => {
    const out = mapSailingListItem({ ...BASE_LIST_ITEM, starting_price_usd: null }, "Norwegian Bliss", "Norwegian Cruise Line");
    expect(out).not.toBeNull();
    expect(out!.cacheQuote).toBeNull();
  });

  it("dayByDay is always null (list items have no per-day detail)", () => {
    const out = mapSailingListItem(BASE_LIST_ITEM, "Norwegian Bliss", "Norwegian Cruise Line");
    expect(out!.dayByDay).toBeNull();
  });

  it("renders deterministic RAG text with the line code", () => {
    const out = mapSailingListItem(BASE_LIST_ITEM, "Norwegian Bliss", "Norwegian Cruise Line");
    expect(out!.text).toContain("NCL");
    expect(out!.text).toContain("Norwegian Bliss");
    expect(out!.text).toContain("2026-04-25");
    expect(out!.text).toContain("$789");
  });

  it("text is deterministic for the same input", () => {
    const a = mapSailingListItem(BASE_LIST_ITEM, "Norwegian Bliss", "Norwegian Cruise Line")!.text;
    const b = mapSailingListItem(BASE_LIST_ITEM, "Norwegian Bliss", "Norwegian Cruise Line")!.text;
    expect(a).toBe(b);
  });
});

describe("chunkSourceIdentifier", () => {
  it("produces a deterministic id from the sailing key", () => {
    const id = chunkSourceIdentifier({
      line: "RCL",
      ship: "Symphony of the Seas",
      sailDate: "2026-08-15",
      departurePort: "Miami",
      durationNights: 7,
    });
    expect(id).toBe("cruisemapper:itinerary:RCL:Symphony of the Seas:2026-08-15:7");
  });
});

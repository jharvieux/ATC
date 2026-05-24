// BP35 §33.4 — itinerary mapper unit tests.

import { describe, expect, it } from "vitest";
import { mapItinerary, chunkSourceIdentifier, type CruiseMapperItineraryItem } from "../../../src/lib/external/cruisemapper/itinerary-mapper";

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

  it("returns null when cruise line can't be normalized to a known code", () => {
    expect(mapItinerary({ ...BASE, cruiseLine: "Some Made-Up Cruise Line" })).toBeNull();
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

  it("normalizes various long-form line names to short codes", () => {
    expect(mapItinerary({ ...BASE, cruiseLine: "Norwegian" })!.key.line).toBe("NCL");
    expect(mapItinerary({ ...BASE, cruiseLine: "Carnival" })!.key.line).toBe("CCL");
    expect(mapItinerary({ ...BASE, cruiseLine: "Princess Cruises" })!.key.line).toBe("PCL");
    expect(mapItinerary({ ...BASE, cruiseLine: "MSC" })!.key.line).toBe("MSC");
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

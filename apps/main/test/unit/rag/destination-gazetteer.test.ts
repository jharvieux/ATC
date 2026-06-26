// §21 — destination → (region terms, port tokens) expansion for region_lookup.
//
// WHY these tests matter: itineraries.region is unset on most regional rows
// (~96% of Australian-port sailings carry NULL region), so a region-label match
// alone misses the bulk of inventory. The gazetteer's job is to expand a named
// area to its major cruise PORTS so a port-token match catches those rows. If the
// Australia→ports expansion silently regressed, the concierge would go back to
// returning almost nothing for "cruises in Australia".

import { describe, it, expect } from "vitest";
import { resolveDestinationToLookupTerms, resolveOriginPortTerms } from "@/lib/rag/destination-gazetteer";

describe("resolveDestinationToLookupTerms", () => {
  it("expands a country/area to its region label AND major cruise ports", () => {
    const { regionTerms, portTerms } = resolveDestinationToLookupTerms(["Australia"], []);
    expect(regionTerms).toContain("Australia");
    // The port expansion is the load-bearing part — it catches the NULL-region rows.
    expect(portTerms).toEqual(expect.arrayContaining(["Sydney", "Brisbane", "Melbourne", "Perth"]));
  });

  it("passes the raw phrase through as both a region and a port term (long-tail without a gazetteer entry)", () => {
    // "Barcelona" has no gazetteer entry; it should still be matchable as a
    // port-of-call via the raw passthrough.
    const { regionTerms, portTerms } = resolveDestinationToLookupTerms(["Barcelona"], []);
    expect(regionTerms).toContain("Barcelona");
    expect(portTerms).toContain("Barcelona");
  });

  it("includes explicitly named departure ports as port terms", () => {
    const { portTerms } = resolveDestinationToLookupTerms(["Australia"], ["Los Angeles"]);
    expect(portTerms).toEqual(expect.arrayContaining(["Sydney", "Los Angeles"]));
  });

  it("is case-insensitive on the gazetteer key", () => {
    const lower = resolveDestinationToLookupTerms(["australia"], []);
    const upper = resolveDestinationToLookupTerms(["AUSTRALIA"], []);
    expect(lower.portTerms).toEqual(expect.arrayContaining(["Sydney"]));
    expect(upper.portTerms).toEqual(expect.arrayContaining(["Sydney"]));
  });

  it("dedupes overlapping terms across multiple destinations", () => {
    const { portTerms } = resolveDestinationToLookupTerms(["Australia", "Australia and New Zealand"], []);
    expect(portTerms.filter((p) => p === "Sydney")).toHaveLength(1);
  });

  it("returns empty term sets for no input", () => {
    const { regionTerms, portTerms } = resolveDestinationToLookupTerms([], []);
    expect(regionTerms).toEqual([]);
    expect(portTerms).toEqual([]);
  });

  it("ignores blank/whitespace destination phrases", () => {
    const { regionTerms, portTerms } = resolveDestinationToLookupTerms(["", "   "], []);
    expect(regionTerms).toEqual([]);
    expect(portTerms).toEqual([]);
  });
});

describe("resolveOriginPortTerms", () => {
  it("expands a country origin to its major embarkation ports, including Alaska and US territories", () => {
    const terms = resolveOriginPortTerms(["United States"]);
    // East/Gulf/West coast, Alaska embarkation, Hawaii, and Puerto Rico all count
    // as "the US" for an origin filter.
    expect(terms).toEqual(expect.arrayContaining([
      "Miami", "Galveston", "Los Angeles", "Seattle",
      "Seward", "Whittier", "Anchorage", "Honolulu", "San Juan",
    ]));
  });

  it("matches the 'the us' / 'usa' synonyms to the same US port set", () => {
    expect(resolveOriginPortTerms(["the US"])).toContain("Seward");
    expect(resolveOriginPortTerms(["usa"])).toContain("Miami");
  });

  it("passes a literal embark port through unchanged", () => {
    expect(resolveOriginPortTerms(["Los Angeles"])).toContain("Los Angeles");
  });

  it("returns [] for no origin", () => {
    expect(resolveOriginPortTerms([])).toEqual([]);
  });
});

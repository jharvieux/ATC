// #486 — Region classifier unit tests.

import { describe, expect, it } from "vitest";
import {
  normalizeCruiseMapperRegion,
  classifyByFirstStop,
  resolveDestinationRegion,
} from "../../../src/lib/cruise-regions/classify";

describe("normalizeCruiseMapperRegion", () => {
  it("maps 'Western Caribbean' → caribbean", () => {
    expect(normalizeCruiseMapperRegion("Western Caribbean")).toBe("caribbean");
  });

  it("maps 'Caribbean' → caribbean", () => {
    expect(normalizeCruiseMapperRegion("Caribbean")).toBe("caribbean");
  });

  it("maps 'Eastern Caribbean' → caribbean", () => {
    expect(normalizeCruiseMapperRegion("Eastern Caribbean")).toBe("caribbean");
  });

  it("maps 'Alaska' → alaska", () => {
    expect(normalizeCruiseMapperRegion("Alaska")).toBe("alaska");
  });

  it("maps 'Norwegian Fjords' → northern_europe", () => {
    expect(normalizeCruiseMapperRegion("Norwegian Fjords")).toBe("northern_europe");
  });

  it("maps 'Baltic' → northern_europe", () => {
    expect(normalizeCruiseMapperRegion("Baltic")).toBe("northern_europe");
  });

  it("maps 'Mediterranean' → mediterranean", () => {
    expect(normalizeCruiseMapperRegion("Mediterranean")).toBe("mediterranean");
  });

  it("maps 'Bahamas' → bahamas", () => {
    expect(normalizeCruiseMapperRegion("Bahamas")).toBe("bahamas");
  });

  it("strips 'Cruise' suffix before matching", () => {
    expect(normalizeCruiseMapperRegion("Alaska Cruise")).toBe("alaska");
    expect(normalizeCruiseMapperRegion("Mediterranean Cruises")).toBe("mediterranean");
  });

  it("is case-insensitive", () => {
    expect(normalizeCruiseMapperRegion("western caribbean")).toBe("caribbean");
    expect(normalizeCruiseMapperRegion("ALASKA")).toBe("alaska");
  });

  it("returns null for empty string", () => {
    expect(normalizeCruiseMapperRegion("")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(normalizeCruiseMapperRegion(null)).toBeNull();
    expect(normalizeCruiseMapperRegion(undefined)).toBeNull();
  });

  it("returns null for unknown region string", () => {
    expect(normalizeCruiseMapperRegion("Crystal Sea")).toBeNull();
    expect(normalizeCruiseMapperRegion("Mystery Voyage")).toBeNull();
  });
});

describe("classifyByFirstStop", () => {
  it("classifies a known caribbean first stop", () => {
    expect(classifyByFirstStop(["Cozumel", "Roatán"])).toBe("caribbean");
  });

  it("classifies a known alaska first stop", () => {
    expect(classifyByFirstStop(["Juneau", "Skagway"])).toBe("alaska");
  });

  it("returns 'other' for empty ports array", () => {
    expect(classifyByFirstStop([])).toBe("other");
  });

  it("returns 'other' for unrecognized first stop", () => {
    expect(classifyByFirstStop(["Atlantis", "Somewhere"])).toBe("other");
  });

  it("uses FIRST stop only — second stop does not affect result", () => {
    // Miami is not in the lookup, but even if it were caribbean, Bermuda is the first real stop
    expect(classifyByFirstStop(["Bermuda", "Nassau"])).toBe("bermuda");
  });

  it("embarkation-port-irrelevant: ['Miami', 'Bermuda'] → bermuda because Bermuda is first in list", () => {
    // If Miami were in the lookup as caribbean, this still returns bermuda
    expect(classifyByFirstStop(["Miami", "Bermuda"])).toBe("bermuda");
  });
});

describe("resolveDestinationRegion", () => {
  it("uses CruiseMapper region when present and recognized", () => {
    expect(resolveDestinationRegion({
      cruisemapper_region: "Western Caribbean",
      ports_of_call: ["Nassau"],
    })).toBe("caribbean");
  });

  it("falls back to first-stop when CruiseMapper region is unrecognized", () => {
    expect(resolveDestinationRegion({
      cruisemapper_region: "Crystal Sea",
      ports_of_call: ["Cozumel"],
    })).toBe("caribbean");
  });

  it("falls back to first-stop when CruiseMapper region is null", () => {
    expect(resolveDestinationRegion({
      cruisemapper_region: null,
      ports_of_call: ["Juneau"],
    })).toBe("alaska");
  });

  it("falls back to first-stop when CruiseMapper region is absent", () => {
    expect(resolveDestinationRegion({
      ports_of_call: ["Nassau"],
    })).toBe("bahamas");
  });

  it("returns 'other' when both CruiseMapper region and first-stop are unknown", () => {
    expect(resolveDestinationRegion({
      cruisemapper_region: "Crystal Sea",
      ports_of_call: ["Nowhere"],
    })).toBe("other");
  });
});

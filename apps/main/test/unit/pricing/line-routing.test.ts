// BP34 §33.3 / D-088 Apify-4 — line-routing unit tests.
// mapSerculItem (outputMapper) is an internal function exposed only through
// LINE_ROUTES[line].outputMapper. Tests exercise it via that path.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APIFY_ACTOR_ALLOWLIST,
  ApifyAllowlistViolation,
  LINE_ROUTES,
  assertActorAllowed,
  groupSailingsForBatch,
  isLineEnabledByEnv,
  matchesAnyWatchedSailing,
  routeFor,
} from "../../../src/lib/pricing/line-routing";
import type { CruiseLineCode, SailingKey } from "../../../src/lib/pricing/types";

function sailing(over: Partial<SailingKey> = {}): SailingKey {
  return {
    line: "RCL",
    ship: "symphony-of-the-seas",
    sailDate: "2026-08-15",
    departurePort: "MIA",
    durationNights: 7,
    ...over,
  };
}

const ENABLED_LINES: CruiseLineCode[] = ["RCL", "NCL", "PCL", "CEL", "COS", "CCL", "HAL", "MSC", "DSY"];

// ── Env hygiene — kill switches read process.env at call time ──────────────
const originalEnv = { ...process.env };
beforeEach(() => {
  for (const l of ENABLED_LINES) delete process.env[`APIFY_ENABLED_${l}`];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("LINE_ROUTES — D-088 Apify-4 catalog", () => {
  it("registers all 9 verified sercul actors", () => {
    for (const line of ENABLED_LINES) {
      const r = LINE_ROUTES[line];
      expect(r, `route for ${line}`).not.toBeNull();
      expect(r!.actorId).toMatch(/^sercul\//);
    }
  });

  it("registers US/USA market codes per actor (sercul codes differ)", () => {
    // sercul/royal-caribbean & siblings use "USA"; the 4 newer actors use "US".
    expect(LINE_ROUTES.RCL!.marketCode).toBe("USA");
    expect(LINE_ROUTES.CCL!.marketCode).toBe("US");
    expect(LINE_ROUTES.MSC!.marketCode).toBe("US");
    expect(LINE_ROUTES.DSY!.marketCode).toBe("US");
  });

  it("leaves the aggregator fallback (BCK) not auto-routed", () => {
    expect(LINE_ROUTES.BCK).toBeNull();
  });
});

describe("buildSerculInput — actor-shape correct", () => {
  it("produces a market-level { region, maxRows, useApifyProxy } envelope", () => {
    const route = LINE_ROUTES.RCL!;
    const input = route.inputBuilder();
    expect(input).toEqual({ region: "USA", maxRows: 2000, useApifyProxy: true });
  });

  it("respects APIFY_MAX_ROWS_PER_RUN override", () => {
    process.env.APIFY_MAX_ROWS_PER_RUN = "500";
    const input = LINE_ROUTES.RCL!.inputBuilder();
    expect(input.maxRows).toBe(500);
    delete process.env.APIFY_MAX_ROWS_PER_RUN;
  });

  it("ignores invalid APIFY_MAX_ROWS_PER_RUN values and uses the default", () => {
    process.env.APIFY_MAX_ROWS_PER_RUN = "not-a-number";
    const input = LINE_ROUTES.RCL!.inputBuilder();
    expect(input.maxRows).toBe(2000);
    delete process.env.APIFY_MAX_ROWS_PER_RUN;
  });
});

describe("isLineEnabledByEnv — per-line kill switch", () => {
  it("defaults true when env var is unset", () => {
    for (const l of ENABLED_LINES) expect(isLineEnabledByEnv(l)).toBe(true);
  });

  it("returns false when APIFY_ENABLED_<LINE>=false", () => {
    process.env.APIFY_ENABLED_MSC = "false";
    expect(isLineEnabledByEnv("MSC")).toBe(false);
    expect(isLineEnabledByEnv("RCL")).toBe(true); // unaffected
  });

  it("treats any non-'false' value as enabled (operator-typo safe)", () => {
    process.env.APIFY_ENABLED_RCL = "true";
    expect(isLineEnabledByEnv("RCL")).toBe(true);
    process.env.APIFY_ENABLED_RCL = "1";
    expect(isLineEnabledByEnv("RCL")).toBe(true);
    process.env.APIFY_ENABLED_RCL = "";
    expect(isLineEnabledByEnv("RCL")).toBe(true);
  });
});

describe("routeFor", () => {
  it("returns a route for every supported line by default", () => {
    for (const line of ENABLED_LINES) {
      const r = routeFor(line);
      expect(r, `route for ${line}`).not.toBeNull();
      expect(r!.cruiseLine).toBe(line);
    }
  });

  it("returns null for a line whose env kill switch is flipped", () => {
    process.env.APIFY_ENABLED_HAL = "false";
    expect(routeFor("HAL")).toBeNull();
    expect(routeFor("RCL")).not.toBeNull(); // unaffected
  });

  it("returns null for the aggregator fallback (BCK)", () => {
    expect(routeFor("BCK")).toBeNull();
  });
});

describe("matchesAnyWatchedSailing — client-side filter", () => {
  it("matches by (ship, sailDate, departurePort, durationNights)", () => {
    const watched = [sailing({ ship: "wonder" })];
    expect(matchesAnyWatchedSailing({ key: sailing({ ship: "wonder" }) }, watched)).toBe(true);
    expect(matchesAnyWatchedSailing({ key: sailing({ ship: "harmony" }) }, watched)).toBe(false);
  });

  it("returns false for empty watched set", () => {
    expect(matchesAnyWatchedSailing({ key: sailing() }, [])).toBe(false);
  });
});

describe("APIFY_ACTOR_ALLOWLIST — D-090 Apify-5", () => {
  it("contains every actorId referenced by LINE_ROUTES", () => {
    for (const line of ENABLED_LINES) {
      const r = LINE_ROUTES[line]!;
      expect(
        APIFY_ACTOR_ALLOWLIST.has(r.actorId),
        `${r.actorId} should be allowlisted`,
      ).toBe(true);
    }
  });

  it("includes the legacy crawlerbros itinerary actor as an emergency escape hatch", () => {
    // Documented in line-routing.ts header — remove when DIY scraper covers itineraries.
    expect(APIFY_ACTOR_ALLOWLIST.has("crawlerbros/cruisemapper-cruises-scraper")).toBe(true);
  });

  it("contains exactly the 9 sercul slugs + 1 legacy slug (drift guard)", () => {
    expect(APIFY_ACTOR_ALLOWLIST.size).toBe(10);
  });
});

describe("assertActorAllowed", () => {
  it("returns silently for an allowlisted actor", () => {
    expect(() => assertActorAllowed("sercul/royal-caribbean")).not.toThrow();
  });

  it("throws ApifyAllowlistViolation for an actor not on the list", () => {
    expect(() => assertActorAllowed("attacker/malicious-actor")).toThrow(ApifyAllowlistViolation);
  });

  it("error message names the offending actor (for ledger forensics)", () => {
    try {
      assertActorAllowed("sercul/non-existent-line");
    } catch (err) {
      expect((err as Error).message).toContain("sercul/non-existent-line");
      expect((err as Error).message).toMatch(/apify_allowlist_violation/);
      return;
    }
    throw new Error("assertActorAllowed did not throw");
  });
});

describe("groupSailingsForBatch — one batch per line", () => {
  it("collapses 30 RCL sailings across 3 ports and 2 months into ONE batch", () => {
    const inputs: SailingKey[] = [];
    for (let day = 1; day <= 30; day += 1) {
      const dd = String(day).padStart(2, "0");
      const port = ["MIA", "FLL", "PCN"][day % 3]!;
      const month = day > 20 ? "09" : "08";
      inputs.push(sailing({ sailDate: `2026-${month}-${dd}`, departurePort: port }));
    }
    const batches = groupSailingsForBatch(inputs);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.sailings).toHaveLength(30);
    expect(batches[0]!.line).toBe("RCL");
  });

  it("splits across cruise lines", () => {
    const batches = groupSailingsForBatch([
      sailing({ line: "RCL" }),
      sailing({ line: "NCL" }),
      sailing({ line: "RCL" }),
    ]);
    expect(batches).toHaveLength(2);
    const rcl = batches.find((b) => b.line === "RCL");
    expect(rcl!.sailings).toHaveLength(2);
  });
});

// ── outputMapper (mapSerculItem) — via LINE_ROUTES[line].outputMapper ────────
//
// mapSerculItem is private but exposed through each line's outputMapper.
// Tests exercise all branches: flat cabinPrices shape, cabins-array shape,
// missing required fields → null, zero/negative price skipped, invalid
// cabin class skipped, non-object input → null.

describe("outputMapper — flat cabinPrices shape (sercul standard output)", () => {
  const mapper = LINE_ROUTES.RCL!.outputMapper;

  it("maps a valid flat-object item to a CachedPriceQuote", () => {
    const item = {
      ship: "symphony-of-the-seas",
      sailDate: "2026-08-15",
      departurePort: "MIA",
      durationNights: 7,
      cabinPrices: {
        interior:  { amount: 1199, currency: "USD" },
        balcony:   { amount: 2099, currency: "USD" },
        oceanview: { amount: 1499, currency: "USD" },
      },
    };
    const result = mapper(item);
    expect(result).not.toBeNull();
    expect(result!.key.line).toBe("RCL");
    expect(result!.key.ship).toBe("symphony-of-the-seas");
    expect(result!.cabinPrices.interior).toEqual({ amount: 1199, currency: "USD" });
    expect(result!.cabinPrices.balcony).toEqual({ amount: 2099, currency: "USD" });
    expect(result!.source).toBe("apify");
  });

  it("accepts departureDate as a sailDate fallback", () => {
    const item = {
      ship: "harmony-of-the-seas",
      departureDate: "2026-09-01",
      departurePort: "BCN",
      durationNights: 14,
      cabinPrices: { interior: { amount: 999, currency: "USD" } },
    };
    const result = mapper(item);
    expect(result).not.toBeNull();
    expect(result!.key.sailDate).toBe("2026-09-01");
  });

  it("accepts embarkPort as a departurePort fallback", () => {
    const item = {
      ship: "oasis-of-the-seas",
      sailDate: "2026-10-10",
      embarkPort: "PCN",
      durationNights: 7,
      cabinPrices: { suite: { amount: 5000, currency: "USD" } },
    };
    const result = mapper(item);
    expect(result!.key.departurePort).toBe("PCN");
  });

  it("accepts nights as a durationNights fallback", () => {
    const item = {
      ship: "wonder-of-the-seas",
      sailDate: "2026-11-01",
      departurePort: "FLL",
      nights: 5,
      cabinPrices: { oceanview: { amount: 1300, currency: "USD" } },
    };
    const result = mapper(item);
    expect(result!.key.durationNights).toBe(5);
  });

  it("skips a cabin whose amount is zero (zero-price entries are not usable)", () => {
    const item = {
      ship: "allure-of-the-seas",
      sailDate: "2026-07-04",
      departurePort: "MIA",
      durationNights: 7,
      cabinPrices: {
        interior: { amount: 0, currency: "USD" },
        balcony:  { amount: 1800, currency: "USD" },
      },
    };
    const result = mapper(item);
    expect(result).not.toBeNull();
    expect(result!.cabinPrices.interior).toBeUndefined();
    expect(result!.cabinPrices.balcony).toBeDefined();
  });

  it("returns null when all cabinPrices have zero or missing amounts", () => {
    const item = {
      ship: "adventure-of-the-seas",
      sailDate: "2026-07-10",
      departurePort: "SJU",
      durationNights: 7,
      cabinPrices: {
        interior: { amount: 0, currency: "USD" },
      },
    };
    expect(mapper(item)).toBeNull();
  });

  it("returns null when cabinPrices is absent and cabins array is absent", () => {
    const item = {
      ship: "explorer-of-the-seas",
      sailDate: "2026-06-15",
      departurePort: "MIA",
      durationNights: 7,
    };
    expect(mapper(item)).toBeNull();
  });
});

describe("outputMapper — missing required fields → null", () => {
  const mapper = LINE_ROUTES.NCL!.outputMapper;

  it("returns null when ship is missing", () => {
    expect(mapper({
      sailDate: "2026-08-01",
      departurePort: "MIA",
      durationNights: 7,
      cabinPrices: { interior: { amount: 900, currency: "USD" } },
    })).toBeNull();
  });

  it("returns null when sailDate and departureDate are both missing", () => {
    expect(mapper({
      ship: "breakaway",
      departurePort: "NYC",
      durationNights: 7,
      cabinPrices: { interior: { amount: 900, currency: "USD" } },
    })).toBeNull();
  });

  it("returns null when departurePort and embarkPort are both missing", () => {
    expect(mapper({
      ship: "bliss",
      sailDate: "2026-09-01",
      durationNights: 7,
      cabinPrices: { interior: { amount: 900, currency: "USD" } },
    })).toBeNull();
  });

  it("returns null when durationNights and nights are both missing", () => {
    expect(mapper({
      ship: "prima",
      sailDate: "2026-09-15",
      departurePort: "NYC",
      cabinPrices: { interior: { amount: 900, currency: "USD" } },
    })).toBeNull();
  });

  it("returns null for a non-object input (e.g., string)", () => {
    expect(mapper("not-an-object")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(mapper(null)).toBeNull();
  });

  it("returns null for an array input", () => {
    expect(mapper([1, 2, 3])).toBeNull();
  });
});

describe("outputMapper — cabins-array shape (alternative sercul output format)", () => {
  const mapper = LINE_ROUTES.CCL!.outputMapper;

  it("maps items from a cabins array when cabinPrices object is absent", () => {
    const item = {
      ship: "celebration",
      sailDate: "2026-12-01",
      departurePort: "MIA",
      durationNights: 7,
      cabins: [
        { cabinClass: "interior",  price: 799 },
        { cabinClass: "balcony",   price: 1299 },
        { cabinClass: "mini_suite", price: 1899 },
      ],
    };
    const result = mapper(item);
    expect(result).not.toBeNull();
    expect(result!.cabinPrices.interior).toEqual({ amount: 799, currency: "USD" });
    expect(result!.cabinPrices.balcony).toEqual({ amount: 1299, currency: "USD" });
    expect(result!.cabinPrices.mini_suite).toEqual({ amount: 1899, currency: "USD" });
  });

  it("skips cabin array entries whose price is zero", () => {
    const item = {
      ship: "mardi-gras",
      sailDate: "2026-11-10",
      departurePort: "PCS",
      durationNights: 7,
      cabins: [
        { cabinClass: "interior", price: 0 },
        { cabinClass: "suite",    price: 3000 },
      ],
    };
    const result = mapper(item);
    expect(result).not.toBeNull();
    expect(result!.cabinPrices.interior).toBeUndefined();
    expect(result!.cabinPrices.suite).toBeDefined();
  });

  it("skips cabin array entries with an invalid cabinClass", () => {
    const item = {
      ship: "carnival-venezia",
      sailDate: "2026-10-01",
      departurePort: "NYC",
      durationNights: 5,
      cabins: [
        { cabinClass: "penthouse", price: 5000 }, // not a valid CabinClass
        { cabinClass: "oceanview", price: 1200 },
      ],
    };
    const result = mapper(item);
    expect(result).not.toBeNull();
    // Only oceanview survived
    expect(Object.keys(result!.cabinPrices)).toEqual(["oceanview"]);
  });

  it("returns null when the cabins array is empty", () => {
    const item = {
      ship: "paradise",
      sailDate: "2026-08-20",
      departurePort: "TPA",
      durationNights: 4,
      cabins: [],
    };
    expect(mapper(item)).toBeNull();
  });

  it("skips non-object entries in the cabins array", () => {
    const item = {
      ship: "elation",
      sailDate: "2026-08-25",
      departurePort: "JAX",
      durationNights: 5,
      cabins: [
        "not-an-object",
        null,
        { cabinClass: "interior", price: 899 },
      ],
    };
    const result = mapper(item);
    expect(result).not.toBeNull();
    expect(result!.cabinPrices.interior).toBeDefined();
  });
});

describe("outputMapper — line code propagation", () => {
  it("embeds the correct cruise-line code for each route", () => {
    // RCL route should stamp key.line = "RCL", CCL → "CCL", etc.
    for (const line of ["RCL", "CCL", "MSC", "HAL", "DSY"] as const) {
      const mapper = LINE_ROUTES[line]!.outputMapper;
      const result = mapper({
        ship: "test-ship",
        sailDate: "2026-08-01",
        departurePort: "MIA",
        durationNights: 7,
        cabinPrices: { interior: { amount: 1000, currency: "USD" } },
      });
      expect(result?.key.line, `line mismatch for ${line}`).toBe(line);
    }
  });
});

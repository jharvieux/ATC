// BP34 §33.3 / D-088 Apify-4 — line-routing unit tests.

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

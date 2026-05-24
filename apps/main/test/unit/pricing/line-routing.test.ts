// BP34 §33.3 — line-routing unit tests.
//
// Two things matter here:
//   1. groupSailingsForBatch buckets sailings by (line, port, month) so
//      30 RCL Caribbean sailings in one month dispatch ONE actor run.
//   2. routeFor returns null for lines whose actor is feature-flagged off
//      OR not in the table at all (caller maps to {status:'unsupported'}).

import { describe, expect, it } from "vitest";
import { groupSailingsForBatch, routeFor, LINE_ROUTES } from "../../../src/lib/pricing/line-routing";
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

describe("groupSailingsForBatch", () => {
  it("collapses 30 RCL/MIA sailings in one month into a single batch", () => {
    const inputs: SailingKey[] = [];
    for (let day = 1; day <= 30; day += 1) {
      const dd = String(day).padStart(2, "0");
      inputs.push(sailing({ sailDate: `2026-08-${dd}` }));
    }
    const batches = groupSailingsForBatch(inputs);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.sailings).toHaveLength(30);
    expect(batches[0]!.line).toBe("RCL");
  });

  it("splits when month boundary crosses", () => {
    const batches = groupSailingsForBatch([
      sailing({ sailDate: "2026-08-30" }),
      sailing({ sailDate: "2026-09-02" }),
    ]);
    expect(batches).toHaveLength(2);
  });

  it("splits across departure ports", () => {
    const batches = groupSailingsForBatch([
      sailing({ departurePort: "MIA" }),
      sailing({ departurePort: "FLL" }),
    ]);
    expect(batches).toHaveLength(2);
  });

  it("splits across cruise lines", () => {
    const batches = groupSailingsForBatch([
      sailing({ line: "RCL" }),
      sailing({ line: "NCL" }),
    ]);
    expect(batches).toHaveLength(2);
  });
});

describe("routeFor", () => {
  it("returns a route for each enabled line", () => {
    const enabled: CruiseLineCode[] = ["RCL", "NCL", "PCL", "CEL", "COS"];
    for (const line of enabled) {
      const r = routeFor(line);
      expect(r, `route for ${line}`).not.toBeNull();
      expect(r!.cruiseLine).toBe(line);
    }
  });

  it("returns null for feature-flagged lines", () => {
    const disabled: CruiseLineCode[] = ["CCL", "HAL", "MSC", "DSY"];
    for (const line of disabled) {
      expect(routeFor(line)).toBeNull();
      expect(LINE_ROUTES[line]?.enabled).toBe(false);
    }
  });

  it("returns null for the aggregator fallback (BCK is not auto-routed)", () => {
    expect(routeFor("BCK")).toBeNull();
    expect(LINE_ROUTES.BCK).toBeNull();
  });
});

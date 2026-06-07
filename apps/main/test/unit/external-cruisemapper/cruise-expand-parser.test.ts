// #827 — cruise-expand-parser unit tests.
//
// Fixture is a REAL /ships/cruise.json response recorded 2026-06-07 for
// Norwegian Prima sailing 4885894 (2026-05-31, 7-night Caribbean from Port
// Canaveral). The fragment is the lazy-loaded day-by-day that the upcoming-
// sailings list omits — this is the #827 source of ports for future sailings.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCruiseExpand } from "../../../src/lib/external/cruisemapper/parsers/cruise-expand-parser";

const FIXTURE_DIR = join(__dirname, "../../fixtures/cruisemapper");
const FRAGMENT = (JSON.parse(readFileSync(join(FIXTURE_DIR, "cruise-detail-4885894.json"), "utf-8")) as { result: string }).result;
const CTX = { departureDate: "2026-05-31", durationNights: 7 };

describe("parseCruiseExpand", () => {
  it("extracts ordered ports of call, excluding the embark/disembark turnaround port", () => {
    const r = parseCruiseExpand(FRAGMENT, CTX);
    expect(r).not.toBeNull();
    expect(r!.ports_of_call).toEqual([
      "Puerto Plata-Amber Cove, Dominicana",
      "St Thomas Island USVI, Charlotte Amalie, US Virgin Islands",
      "Tortola Island BVI, Road Town, UK Virgin Islands",
      "Great Stirrup Cay, Bahamas NCL private island",
    ]);
    // The turnaround port (Port Canaveral) is embark+disembark, never a "stop".
    expect(r!.ports_of_call.some((p) => /port canaveral/i.test(p))).toBe(false);
    // The hotels link in the embark/disembark cell must not leak into a port.
    expect(r!.ports_of_call.some((p) => /hotel/i.test(p))).toBe(false);
  });

  it("reconstructs the implicit sea days from departure date + duration", () => {
    const r = parseCruiseExpand(FRAGMENT, CTX)!;
    // 7 nights → 8 calendar days, embark (day 1) through return (day 8).
    expect([...new Set(r.itinerary.map((d) => d.day_number))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 01 Jun and 05 Jun have no port row → filled as at-sea days.
    expect(r.itinerary.filter((d) => d.port_name === null).map((d) => d.date)).toEqual(["2026-06-01", "2026-06-05"]);
  });

  it("records the embark departure time and the disembark arrival time", () => {
    const r = parseCruiseExpand(FRAGMENT, CTX)!;
    const first = r.itinerary[0]!;
    expect(first.day_number).toBe(1);
    expect(first.departure_time).toBe("16:00");
    expect(first.arrival_time).toBeNull();
    const last = r.itinerary[r.itinerary.length - 1]!;
    expect(last.day_number).toBe(8);
    expect(last.arrival_time).toBe("06:00");
    expect(last.departure_time).toBeNull();
  });

  it("returns null when the fragment has no itinerary table (layout drift)", () => {
    expect(parseCruiseExpand("<div>no table here</div>", CTX)).toBeNull();
  });

  it("returns null when the caller's departure date is malformed", () => {
    expect(parseCruiseExpand(FRAGMENT, { departureDate: "nope", durationNights: 7 })).toBeNull();
  });
});

// #781 — resolve-canonical.ts unit tests.
// Verifies that resolveCanonical() matches known lines/ships and returns
// { matched: false } for junk input, and that queueForReview() upserts
// the right row shape to canonical_match_reviews.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  cruiseLines: [] as Array<{ id: string; slug: string; canonical_name: string; display_name: string }>,
  cruiseLineAliases: null as { cruise_line_id: string } | null,
  cruiseShipAliases: null as { cruise_ship_id: string } | null,
  cruiseShips: [] as Array<{ id: string; slug: string; canonical_name: string }>,
  upsertError: null as { message: string } | null,
  lastUpsert: null as Record<string, unknown> | null,
}));

function makeDb() {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          const chain: Record<string, unknown> = {
            eq(_col: string, _val: unknown) { return chain; },
            maybeSingle() {
              if (table === "cruise_line_aliases") {
                return Promise.resolve({ data: mocks.cruiseLineAliases });
              }
              if (table === "cruise_ship_aliases") {
                return Promise.resolve({ data: mocks.cruiseShipAliases });
              }
              return Promise.resolve({ data: null });
            },
            then(resolve: (v: { data: unknown }) => unknown) {
              if (table === "cruise_lines") {
                return resolve({ data: mocks.cruiseLines });
              }
              if (table === "cruise_ships") {
                return resolve({ data: mocks.cruiseShips });
              }
              return resolve({ data: [] });
            },
          };
          return chain;
        },
        upsert(row: Record<string, unknown>, _opts?: unknown) {
          mocks.lastUpsert = row;
          return Promise.resolve({ error: mocks.upsertError });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { resolveCanonical, queueForReview } from "@/lib/canonical/resolve-canonical";

beforeEach(() => {
  mocks.cruiseLines = [];
  mocks.cruiseLineAliases = null;
  mocks.cruiseShipAliases = null;
  mocks.cruiseShips = [];
  mocks.upsertError = null;
  mocks.lastUpsert = null;
});

describe("resolveCanonical — line", () => {
  it("returns matched:false for null input", async () => {
    const db = makeDb();
    const result = await resolveCanonical(null, "line", db as never);
    expect(result.matched).toBe(false);
  });

  it("returns matched:false for blank input", async () => {
    const db = makeDb();
    const result = await resolveCanonical("   ", "line", db as never);
    expect(result.matched).toBe(false);
  });

  it("matches on display_name (case-insensitive)", async () => {
    mocks.cruiseLines = [{ id: "line-1", slug: "royal-caribbean", canonical_name: "Royal Caribbean International", display_name: "Royal Caribbean" }];
    const db = makeDb();
    const result = await resolveCanonical("ROYAL CARIBBEAN", "line", db as never);
    expect(result).toEqual({ matched: true, id: "line-1" });
  });

  it("matches 'Royal Caribbean Cruises' via suffix-strip variant", async () => {
    mocks.cruiseLines = [{ id: "line-1", slug: "royal-caribbean", canonical_name: "Royal Caribbean International", display_name: "Royal Caribbean" }];
    const db = makeDb();
    // "Royal Caribbean Cruises" → strip "cruises" → "royal caribbean" → matches display_name
    const result = await resolveCanonical("Royal Caribbean Cruises", "line", db as never);
    expect(result).toEqual({ matched: true, id: "line-1" });
  });

  it("matches via alias table", async () => {
    mocks.cruiseLines = [];
    mocks.cruiseLineAliases = { cruise_line_id: "line-2" };
    const db = makeDb();
    const result = await resolveCanonical("MSC Cruises", "line", db as never);
    expect(result).toEqual({ matched: true, id: "line-2" });
  });

  it("returns matched:false for unrecognized junk", async () => {
    mocks.cruiseLines = [{ id: "line-1", slug: "royal-caribbean", canonical_name: "Royal Caribbean International", display_name: "Royal Caribbean" }];
    const db = makeDb();
    const result = await resolveCanonical("NOT A REAL CRUISE LINE XYZ123", "line", db as never);
    expect(result.matched).toBe(false);
  });
});

describe("resolveCanonical — ship", () => {
  it("matches via ship alias", async () => {
    mocks.cruiseShipAliases = { cruise_ship_id: "ship-1" };
    const db = makeDb();
    const result = await resolveCanonical("Harmony of the Seas", "ship", db as never);
    expect(result).toEqual({ matched: true, id: "ship-1" });
  });

  it("matches via ship canonical_name", async () => {
    mocks.cruiseShips = [{ id: "ship-2", slug: "wonder-of-the-seas", canonical_name: "Wonder of the Seas" }];
    const db = makeDb();
    const result = await resolveCanonical("Wonder of the Seas", "ship", db as never);
    expect(result).toEqual({ matched: true, id: "ship-2" });
  });

  it("returns matched:false for unknown ship", async () => {
    const db = makeDb();
    const result = await resolveCanonical("SS Nessie", "ship", db as never);
    expect(result.matched).toBe(false);
  });
});

describe("queueForReview", () => {
  it("upserts normalized value with source metadata", async () => {
    const db = makeDb();
    await queueForReview("Norwegian Escape", "ship", { table: "bookings", column: "ship_name" }, db as never);
    expect(mocks.lastUpsert).toMatchObject({
      entity_type: "ship",
      value_normalized: "norwegian escape",
      value_raw: "Norwegian Escape",
      source_table: "bookings",
      source_column: "ship_name",
    });
  });

  it("logs error on upsert failure but does not throw", async () => {
    mocks.upsertError = { message: "db error" };
    const db = makeDb();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      queueForReview("Junk", "line", { table: "quote_options", column: "cruise_line" }, db as never),
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith("canonical_match_reviews.upsert failed", "db error");
    consoleSpy.mockRestore();
  });
});

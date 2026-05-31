// #484 — lookupPortByName: exact port_name match, then name_aliases match.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  lookupPortByName,
  pgTextArrayContainsLiteral,
} from "@/lib/ports/lookup-by-name";

interface SeedRow {
  port_code: string;
  port_name: string;
  latitude: number | null;
  longitude: number | null;
  name_aliases: string[];
}

const SEED: SeedRow[] = [
  { port_code: "RTB", port_name: "Roatán, Honduras", latitude: 16.3, longitude: -86.53, name_aliases: ["Roatan", "Mahogany Bay", "Coxen Hole", "Roatan, Honduras"] },
  { port_code: "MIA", port_name: "Miami, FL", latitude: 25.7617, longitude: -80.1918, name_aliases: ["Miami", "PortMiami"] },
];

// Inverse of pgTextArrayContainsLiteral — recover the single element the helper
// asked for so the fake can match it against name_aliases.
function parseContainsLiteral(literal: string): string {
  const inner = literal.slice(1, -1); // strip { }
  const unquoted = inner.replace(/^"|"$/g, "");
  return unquoted.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// Models the two query shapes lookupPortByName issues:
//   exact: .eq("port_name", v).maybeSingle()
//   alias: .filter("name_aliases", "cs", literal).limit(1).maybeSingle()
// `forceError` makes maybeSingle return a PostgrestError so the fail-loud
// path can be exercised.
function makeDb(rows: SeedRow[], forceError = false): Pick<SupabaseClient, "from"> {
  return {
    from() {
      const state: { mode?: "exact" | "alias"; value?: string } = {};
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: string) {
          if (col === "port_name") {
            state.mode = "exact";
            state.value = val;
          }
          return builder;
        },
        filter(col: string, op: string, val: string) {
          if (col === "name_aliases" && op === "cs") {
            state.mode = "alias";
            state.value = parseContainsLiteral(val);
          }
          return builder;
        },
        limit() {
          return builder;
        },
        async maybeSingle() {
          if (forceError) {
            return { data: null, error: { message: "connection reset" } };
          }
          const project = (r: SeedRow) => ({
            port_code: r.port_code,
            port_name: r.port_name,
            latitude: r.latitude,
            longitude: r.longitude,
          });
          if (state.mode === "exact") {
            const hit = rows.find((r) => r.port_name === state.value);
            return { data: hit ? project(hit) : null, error: null };
          }
          if (state.mode === "alias") {
            const hit = rows.find((r) => r.name_aliases.includes(state.value ?? ""));
            return { data: hit ? project(hit) : null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  } as unknown as Pick<SupabaseClient, "from">;
}

describe("pgTextArrayContainsLiteral", () => {
  it("quotes the element so commas don't split it into two array entries", () => {
    // The whole point: "Roatán, Honduras" must stay ONE element. A bare
    // `{Roatán, Honduras}` literal would parse as ["Roatán"," Honduras"].
    expect(pgTextArrayContainsLiteral("Roatán, Honduras")).toBe('{"Roatán, Honduras"}');
  });

  it("escapes embedded double-quotes and backslashes", () => {
    expect(pgTextArrayContainsLiteral('a"b\\c')).toBe('{"a\\"b\\\\c"}');
  });
});

describe("lookupPortByName", () => {
  it("resolves an exact port_name match", async () => {
    const out = await lookupPortByName(makeDb(SEED), "Miami, FL");
    expect(out?.port_code).toBe("MIA");
    expect(out?.port_name).toBe("Miami, FL");
  });

  it("resolves via name_aliases when port_name does not match exactly", async () => {
    // CruiseMapper sends "Mahogany Bay"; the exact match misses, the alias hits.
    const out = await lookupPortByName(makeDb(SEED), "Mahogany Bay");
    expect(out?.port_code).toBe("RTB");
    expect(out?.port_name).toBe("Roatán, Honduras");
  });

  it("resolves a comma-containing alias (accent-stripped CruiseMapper label)", async () => {
    // "Roatan, Honduras" differs from port_name only by the missing accent;
    // it is a comma-containing ALIAS, so it must survive the array literal.
    const out = await lookupPortByName(makeDb(SEED), "Roatan, Honduras");
    expect(out?.port_code).toBe("RTB");
  });

  it("returns null for an unknown port", async () => {
    const out = await lookupPortByName(makeDb(SEED), "Atlantis");
    expect(out).toBeNull();
  });

  it("returns null (without querying) for an empty/whitespace name", async () => {
    const out = await lookupPortByName(makeDb(SEED), "   ");
    expect(out).toBeNull();
  });

  it("returns lat/lon as numbers, not strings (callers do arithmetic on them)", async () => {
    const out = await lookupPortByName(makeDb(SEED), "Roatan");
    expect(typeof out?.latitude).toBe("number");
    expect(typeof out?.longitude).toBe("number");
    expect(out?.latitude).toBeCloseTo(16.3, 4);
  });

  it("throws (fail-loud) when the query errors rather than masking it as not-found", async () => {
    await expect(lookupPortByName(makeDb(SEED, true), "Miami, FL")).rejects.toThrow(
      /port_info_chunks\.lookup\.exact failed/,
    );
  });
});

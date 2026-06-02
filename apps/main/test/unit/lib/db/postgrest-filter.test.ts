// #558 — escapeIlikeOrTerm sanitizes user input before it is interpolated into
// a PostgREST `.or()` ilike filter. The tests encode the security intent: a
// caller must not be able to (a) inject extra OR conditions via filter
// metacharacters, or (b) widen their own match via SQL LIKE wildcards. Each
// assertion flips if the escaping is removed.

import { describe, it, expect } from "vitest";
import { escapeIlikeOrTerm } from "@/lib/db/postgrest-filter";

describe("escapeIlikeOrTerm (#558 PostgREST filter-injection guard)", () => {
  it("wraps the term in % for a contains-match", () => {
    expect(escapeIlikeOrTerm("jordan")).toBe("%jordan%");
  });

  it("strips the comma that would start a new OR condition", () => {
    // Raw interpolation of "a,b" yields `...ilike.%a,b%,...` — the comma opens an
    // attacker-chosen condition. After escaping the value carries no comma.
    expect(escapeIlikeOrTerm("a,b")).toBe("%ab%");
  });

  it("strips PostgREST grouping/modifier chars ( ) :", () => {
    expect(escapeIlikeOrTerm("x(or)y:z")).toBe("%xoryz%");
  });

  it("backslash-escapes SQL LIKE wildcards so they match literally", () => {
    // Without escaping, "%" and "_" widen the match; "\" is the LIKE escape char.
    expect(escapeIlikeOrTerm("50%")).toBe("%50\\%%");
    expect(escapeIlikeOrTerm("a_b")).toBe("%a\\_b%");
    expect(escapeIlikeOrTerm("a\\b")).toBe("%a\\\\b%");
  });

  it("preserves dots and @ so email search still works", () => {
    expect(escapeIlikeOrTerm("john.doe@example.com")).toBe("%john.doe@example.com%");
  });

  it("trims surrounding whitespace before wrapping", () => {
    expect(escapeIlikeOrTerm("  ann  ")).toBe("%ann%");
  });

  it("collapses a full injection payload to an inert literal", () => {
    // Raw, `x%,email.ilike.%(secret` would add an `email.ilike.%(secret` term.
    // Escaped: comma + paren removed, both % backslash-escaped → no new condition,
    // no live wildcard.
    expect(escapeIlikeOrTerm("x%,email.ilike.%(secret")).toBe(
      "%x\\%email.ilike.\\%secret%",
    );
  });
});

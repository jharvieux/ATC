// Tests for the AdminSidebar collapsed-cookie serializer/parser. The
// round-trip + defensive-parse invariants matter because the server's
// initial SSR HTML depends on parsing the cookie correctly (#669) — if
// parse silently drops state, the operator sees the flash this PR
// exists to remove.

import { describe, it, expect } from "vitest";
import {
  parseCollapsedCookie,
  serializeCollapsedCookie,
  COOKIE_NAME,
} from "@/components/admin-shell/collapsed-cookie";

describe("parseCollapsedCookie", () => {
  it("returns empty object when the cookie is absent (operator has never collapsed anything)", () => {
    expect(parseCollapsedCookie(undefined)).toEqual({});
  });

  it("returns empty object when the cookie is the empty string", () => {
    expect(parseCollapsedCookie("")).toEqual({});
  });

  it("returns the persisted map for a well-formed cookie", () => {
    const encoded = encodeURIComponent(JSON.stringify({ "Tenants & Access": true, "Help": false }));
    expect(parseCollapsedCookie(encoded)).toEqual({
      "Tenants & Access": true,
      "Help": false,
    });
  });

  it("drops non-boolean values defensively (a future schema migration shouldn't accidentally inject garbage)", () => {
    // The cookie is operator-set; the format is technically tamperable.
    // The parser must not propagate a number or string as a boolean.
    const encoded = encodeURIComponent(
      JSON.stringify({ "valid": true, "bogus": 42, "alsoBogus": "yes" }),
    );
    expect(parseCollapsedCookie(encoded)).toEqual({ "valid": true });
  });

  it("returns empty object on malformed JSON (don't throw the layout)", () => {
    expect(parseCollapsedCookie("not%20json")).toEqual({});
  });

  it("returns empty object when the parsed value is an array (defensive)", () => {
    const encoded = encodeURIComponent(JSON.stringify(["not", "a", "map"]));
    expect(parseCollapsedCookie(encoded)).toEqual({});
  });

  it("returns empty object when the parsed value is null", () => {
    expect(parseCollapsedCookie(encodeURIComponent("null"))).toEqual({});
  });
});

describe("serializeCollapsedCookie", () => {
  it("emits a cookie string with the canonical name + the JSON-encoded state", () => {
    const cookieStr = serializeCollapsedCookie({ "Tenants & Access": true });
    expect(cookieStr.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    expect(cookieStr).toContain("Path=/");
    expect(cookieStr).toContain("Max-Age=");
    expect(cookieStr).toContain("SameSite=Lax");
  });

  it("round-trips: parse(serialize(state)) === state for the data that lives in the map", () => {
    // The Set-Cookie format prefixes `${COOKIE_NAME}=`, so the parser
    // sees just the value portion. Extract that portion and verify the
    // round-trip semantically matches.
    const state = { "Tenants & Access": true, "Help": false, "Resources": true };
    const serialized = serializeCollapsedCookie(state);
    const valuePortion = serialized.split(";")[0]!.split("=").slice(1).join("=");
    expect(parseCollapsedCookie(valuePortion)).toEqual(state);
  });
});

// §17.x — ssr-client cookie parsing.
//
// WHY this matters: @supabase/ssr resolves the session by name-matching the
// cookies returned from getAll (chunked: sb-<ref>-auth-token.0, .1, ...). If
// parseCookieHeader drops a chunk, mangles a base64url value, or splits on the
// wrong '=', the reassembled session JWT is corrupt and getUser() fails —
// which presents as every authenticated user being silently logged out. None
// of that is caught by typecheck, so the round-trip is pinned here. The route
// handlers and middleware read cookies via NextRequest.cookies (Next's own,
// already-tested parser); only the request-scoped read path uses this parser,
// so this is the seam under test.

import { describe, it, expect } from "vitest";
import { parseCookieHeader } from "@/lib/auth/ssr-client";

describe("parseCookieHeader", () => {
  it("returns [] for null / undefined / empty header", () => {
    expect(parseCookieHeader(null)).toEqual([]);
    expect(parseCookieHeader(undefined)).toEqual([]);
    expect(parseCookieHeader("")).toEqual([]);
  });

  it("parses a single name=value pair", () => {
    expect(parseCookieHeader("session=abc123")).toEqual([
      { name: "session", value: "abc123" },
    ]);
  });

  it("parses multiple '; '-separated cookies in order", () => {
    expect(parseCookieHeader("a=1; b=2; c=3")).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
      { name: "c", value: "3" },
    ]);
  });

  it("preserves chunked Supabase auth-token cookies and their order", () => {
    const ref = "abcdefghijklmnop";
    const header = `sb-${ref}-auth-token.0=chunk0; sb-${ref}-auth-token.1=chunk1`;
    expect(parseCookieHeader(header)).toEqual([
      { name: `sb-${ref}-auth-token.0`, value: "chunk0" },
      { name: `sb-${ref}-auth-token.1`, value: "chunk1" },
    ]);
  });

  it("does not corrupt base64url values containing - and _", () => {
    // base64url alphabet uses - and _ which are not percent-encoded; they must
    // survive verbatim or the JWT signature segment is mangled.
    const value = "eyJhbGc-iOiJIUzI_1NiIsInR5cCI6IkpXVCJ9";
    expect(parseCookieHeader(`token=${value}`)).toEqual([
      { name: "token", value },
    ]);
  });

  it("decodes percent-encoded values (cookie serializer encodes on write)", () => {
    // {"a":1} encoded via encodeURIComponent.
    expect(parseCookieHeader("j=%7B%22a%22%3A1%7D")).toEqual([
      { name: "j", value: '{"a":1}' },
    ]);
  });

  it("splits only on the first '=' so base64-padded values survive", () => {
    expect(parseCookieHeader("t=YWJjZA==")).toEqual([
      { name: "t", value: "YWJjZA==" },
    ]);
  });

  it("strips one layer of surrounding double quotes", () => {
    expect(parseCookieHeader('q="quoted value"')).toEqual([
      { name: "q", value: "quoted value" },
    ]);
  });

  it("keeps the raw value when percent-decoding throws (no crash)", () => {
    // A lone % is invalid percent-encoding; decodeURIComponent would throw.
    expect(parseCookieHeader("bad=100%off")).toEqual([
      { name: "bad", value: "100%off" },
    ]);
  });

  it("trims whitespace around names and skips malformed segments", () => {
    expect(parseCookieHeader("  a =1;  ; novalue ; b=2")).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
  });
});

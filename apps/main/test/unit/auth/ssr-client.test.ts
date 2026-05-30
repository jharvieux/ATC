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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

let capturedCookieAdapter: {
  getAll?: () => { name: string; value: string }[];
  setAll?: (
    cookies: { name: string; value: string; options: Record<string, unknown> }[],
    headers: Record<string, string>,
  ) => void;
} = {};

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: { cookies: typeof capturedCookieAdapter },
  ) => {
    capturedCookieAdapter = opts.cookies;
    return { __mock: true };
  },
}));

import {
  parseCookieHeader,
  createMiddlewareClient,
  createRouteHandlerClient,
} from "@/lib/auth/ssr-client";

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

// WHY: createMiddlewareClient sits under proxy.ts and is what keeps cookie
// sessions alive. Two contract-shaped invariants matter — if either breaks,
// users get logged out at the 1h access-token expiry mark:
//   1. setAll must mutate req.cookies so the forwarded Cookie header carries
//      the rotated access token to the handler on THIS pass (probe-verified
//      that req.cookies.set propagates into new Headers(req.headers)).
//   2. applyRefreshedSession must flush the captured cookies AND Supabase's
//      mandatory no-cache headers onto whichever response proxy.ts returns.
describe("createMiddlewareClient", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    capturedCookieAdapter = {};
  });

  it("setAll writes rotated cookies onto req.cookies (so cloneAndScrubHeaders forwards the fresh token)", () => {
    const req = new NextRequest("https://x.example.com/p", {
      headers: { cookie: "existing=1" },
    });
    createMiddlewareClient(req);

    capturedCookieAdapter.setAll!(
      [{ name: "sb-x-auth-token", value: "rotated", options: {} }],
      {},
    );

    // Verified via probe: req.cookies.set propagates into req.headers.
    const forwarded = new Headers(req.headers).get("cookie") ?? "";
    expect(forwarded).toContain("sb-x-auth-token=rotated");
  });

  it("applyRefreshedSession is a no-op when getUser did not refresh (steady state)", () => {
    const req = new NextRequest("https://x.example.com/p");
    const { applyRefreshedSession } = createMiddlewareClient(req);

    const res = NextResponse.next();
    const before = res.headers.get("set-cookie");
    applyRefreshedSession(res);
    expect(res.headers.get("set-cookie")).toBe(before);
  });

  it("createRouteHandlerClient.applyAuthCookies also flushes the no-cache headers (login responses must not be CDN-cached)", () => {
    const req = new NextRequest("https://x.example.com/p");
    const { applyAuthCookies } = createRouteHandlerClient(req);

    capturedCookieAdapter.setAll!(
      [{ name: "sb-x-auth-token", value: "v", options: { path: "/" } }],
      { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0" },
    );

    const res = NextResponse.json({ ok: true });
    applyAuthCookies(res);
    expect(res.headers.get("set-cookie")).toContain("sb-x-auth-token=v");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });

  it("applyRefreshedSession flushes captured cookies and the no-cache headers Supabase mandated", () => {
    const req = new NextRequest("https://x.example.com/p");
    const { applyRefreshedSession } = createMiddlewareClient(req);

    capturedCookieAdapter.setAll!(
      [
        {
          name: "sb-x-auth-token",
          value: "rotated",
          options: { path: "/", httpOnly: true, sameSite: "lax" },
        },
      ],
      { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0" },
    );

    const res = NextResponse.next();
    applyRefreshedSession(res);

    expect(res.headers.get("set-cookie")).toContain("sb-x-auth-token=rotated");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });
});

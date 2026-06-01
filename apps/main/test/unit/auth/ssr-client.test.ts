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

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
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
  getAuthCookieDomain,
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

// WHY: auth happens on the platform primary domain, but the operator's
// workspace lives on a tenant subdomain. Without an explicit cookie domain
// the session does NOT carry across the post-signup redirect, every API
// call comes back 401, and the user cannot accept legal docs to finish
// onboarding. This test pins the rule that resolves the gap.
describe("getAuthCookieDomain", () => {
  const originalPrimary = process.env.PLATFORM_PRIMARY_DOMAIN;

  beforeEach(() => {
    process.env.PLATFORM_PRIMARY_DOMAIN = "ai-travelconcierge.com";
  });

  afterAll(() => {
    if (originalPrimary === undefined) delete process.env.PLATFORM_PRIMARY_DOMAIN;
    else process.env.PLATFORM_PRIMARY_DOMAIN = originalPrimary;
  });

  it("returns .<primary> when the request is on the platform primary domain itself", () => {
    const req = new NextRequest("https://ai-travelconcierge.com/api/auth/callback");
    expect(getAuthCookieDomain(req)).toBe(".ai-travelconcierge.com");
  });

  it("returns .<primary> when the request is on a subdomain of the platform primary", () => {
    const req = new NextRequest("https://booking.ai-travelconcierge.com/onboarding/legal");
    expect(getAuthCookieDomain(req)).toBe(".ai-travelconcierge.com");
  });

  it("returns undefined for an unrelated apex domain (custom-domain tenants stay host-only)", () => {
    const req = new NextRequest("https://booking.example.com/onboarding/legal");
    expect(getAuthCookieDomain(req)).toBeUndefined();
  });

  it("returns undefined for *.vercel.app preview deploys", () => {
    const req = new NextRequest("https://atc-main-abc.vercel.app/api/auth/callback");
    expect(getAuthCookieDomain(req)).toBeUndefined();
  });

  it("returns undefined for localhost (browsers reject explicit domain on localhost)", () => {
    process.env.PLATFORM_PRIMARY_DOMAIN = "localhost";
    const req = new NextRequest("http://localhost:3000/api/auth/callback");
    expect(getAuthCookieDomain(req)).toBeUndefined();
  });

  it("returns undefined when PLATFORM_PRIMARY_DOMAIN is unset (no decision possible)", () => {
    delete process.env.PLATFORM_PRIMARY_DOMAIN;
    const req = new NextRequest("https://ai-travelconcierge.com/api/auth/callback");
    expect(getAuthCookieDomain(req)).toBeUndefined();
  });

  it("does not match a domain that merely ENDS WITH the primary (subdomain check is strict)", () => {
    // "evil-ai-travelconcierge.com" ends with "ai-travelconcierge.com" but
    // is not a subdomain. The check must require either equality or a
    // leading "." segment boundary.
    const req = new NextRequest("https://evil-ai-travelconcierge.com/x");
    expect(getAuthCookieDomain(req)).toBeUndefined();
  });
});

// WHY: the route-handler + middleware clients are the two places where
// cookies actually get WRITTEN. The cookie-domain helper must reach
// pending cookies via setAll so the post-signup redirect carries the
// session across to the tenant subdomain.
describe("auth cookie domain is injected on write", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    process.env.PLATFORM_PRIMARY_DOMAIN = "ai-travelconcierge.com";
    capturedCookieAdapter = {};
  });

  it("createRouteHandlerClient on the platform domain stamps domain=.<primary> onto every cookie it writes", () => {
    const req = new NextRequest("https://ai-travelconcierge.com/api/auth/callback");
    const { applyAuthCookies } = createRouteHandlerClient(req);

    capturedCookieAdapter.setAll!(
      [{ name: "sb-x-auth-token", value: "v", options: { path: "/", httpOnly: true } }],
      {},
    );

    const res = NextResponse.json({ ok: true });
    applyAuthCookies(res);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Domain=.ai-travelconcierge.com");
  });

  it("createMiddlewareClient on a tenant subdomain still stamps domain=.<primary> (refresh on subdomain re-issues a parent-scoped cookie)", () => {
    const req = new NextRequest("https://booking.ai-travelconcierge.com/dashboard");
    const { applyRefreshedSession } = createMiddlewareClient(req);

    capturedCookieAdapter.setAll!(
      [{ name: "sb-x-auth-token", value: "rotated", options: { path: "/" } }],
      {},
    );

    const res = NextResponse.next();
    applyRefreshedSession(res);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Domain=.ai-travelconcierge.com");
  });

  it("on a non-platform host (preview / custom domain) cookies stay host-only", () => {
    const req = new NextRequest("https://atc-main-abc.vercel.app/api/auth/callback");
    const { applyAuthCookies } = createRouteHandlerClient(req);

    capturedCookieAdapter.setAll!(
      [{ name: "sb-x-auth-token", value: "v", options: { path: "/" } }],
      {},
    );

    const res = NextResponse.json({ ok: true });
    applyAuthCookies(res);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toMatch(/Domain=/i);
  });
});

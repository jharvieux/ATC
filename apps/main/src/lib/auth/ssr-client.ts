// §17.x — @supabase/ssr cookie-adapter Supabase client factories.
//
// Replaces the implicit-flow `createClient(...persistSession:false)` clients
// that put OAuth tokens in the URL fragment and never wrote a browser session
// (the #access_token=... redirect bug). With @supabase/ssr the PKCE
// code_verifier and the session tokens live in HttpOnly cookies, exchanged and
// refreshed server-side.
//
// Three shapes the app needs:
//
//   createRouteHandlerClient(req)   — read + write. The OAuth entry/exit routes
//     (oauth-initiate, callback) sign in / exchange the code; the Supabase
//     client wants to SET cookies (PKCE verifier on initiate, session tokens on
//     exchange). We capture those writes and flush them onto the route's
//     NextResponse via applyAuthCookies(res).
//
//   createMiddlewareClient(req)     — read + write, used by proxy.ts. getUser()
//     triggers a refresh when the access token has expired; setAll then (a)
//     writes the rotated cookies back onto req.cookies so the downstream
//     handler sees the fresh token on THIS pass (NextRequest.cookies mutations
//     propagate into the Cookie header proxy.ts forwards via NextResponse.next)
//     and (b) captures them so applyRefreshedSession can flush Set-Cookie +
//     the no-cache headers onto whichever response the resolution branch picks
//     (next / redirect / 404). Supabase rotates the refresh token on every
//     use, so this is the ONLY place that refreshes — without it sessions die
//     the first time the 1h access token expires.
//
//   createRequestScopedClient(req)  — read only. tenantContextFromRequest and
//     assertPermission resolve + verify the session (getUser) from the request
//     cookies. setAll is a no-op: the middleware owns refresh, and these
//     helpers run deep inside handlers where there is no response to write to.

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest, NextResponse } from "next/server";

// verifyEnvAtBoot (lib/env.ts) is the primary gate; this is defense-in-depth
// so a missing var surfaces a named error instead of @supabase/ssr's generic
// "URL and Key are required" message buried in a route stack.
function supabaseAnonConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "ssr-client: Supabase env not configured " +
        "(NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).",
    );
  }
  return { url, anonKey };
}

// Read-only parse of a request's Cookie header into the { name, value }[] shape
// @supabase/ssr's getAll expects. Mirrors `cookie@1.1.1` semantics (the parser
// @supabase/ssr itself uses) closely enough to round-trip the cookies it
// writes: split on ';', first '=' splits name/value, strip one layer of
// surrounding quotes, decodeURIComponent with a raw-value fallback. A wrong
// parse here silently fails getUser and logs every user out, so it is unit
// tested in ssr-client.test.ts.
export function parseCookieHeader(
  header: string | null | undefined,
): { name: string; value: string }[] {
  if (!header) return [];
  const out: { name: string; value: string }[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!name) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding — keep the raw value, matching `cookie`.
    }
    out.push({ name, value });
  }
  return out;
}

// @supabase/ssr types cookie options as Partial<SerializeOptions>, which is
// wider than NextResponse's ResponseCookie (sameSite includes capitalized
// variants; an `encode` fn field exists). At runtime the library only ever
// emits the standard lowercase fields, so this cast is safe at the boundary.
// NextResponse.cookies.set is overloaded ([name, value, opts] | [cookie]); pick
// the single-object overload's parameter type.
type ResponseCookieInput = Extract<
  Parameters<NextResponse["cookies"]["set"]>[0],
  object
>;

function toResponseCookie(
  name: string,
  value: string,
  options: CookieOptions,
): ResponseCookieInput {
  return { name, value, ...options } as ResponseCookieInput;
}

// Flush the captured Set-Cookie writes + any extra headers onto whichever
// response the caller picked. Both factories below buffer into `pending`
// because @supabase/ssr's setAll fires before the response object exists.
function flushCapturedCookies<T extends NextResponse>(
  res: T,
  pending: { name: string; value: string; options: CookieOptions }[],
  extraHeaders: Record<string, string>,
): T {
  for (const { name, value, options } of pending) {
    res.cookies.set(toResponseCookie(name, value, options));
  }
  for (const [key, val] of Object.entries(extraHeaders)) {
    res.headers.set(key, val);
  }
  return res;
}

// §17.x — Cross-subdomain cookie scope.
//
// Auth happens on the platform primary domain (e.g. ai-travelconcierge.com)
// but the operator's workspace lives on a tenant subdomain
// (e.g. booking.ai-travelconcierge.com). Without an explicit cookie domain,
// browsers scope cookies to the exact host that set them, so the auth
// session does NOT carry across the post-signup redirect — every API call
// from the subdomain page comes back 401.
//
// Returns the value to assign to cookie.domain so a single sign-in covers
// the platform + all *.platform-primary-domain subdomains. Returns
// undefined for hostnames the rule does not apply to:
//   - localhost (no dot, browsers treat dotted-domain on localhost
//     inconsistently — leave host-only)
//   - preview deploys (*.vercel.app etc., hostname not under the platform
//     primary)
//   - custom-domain tenants (their own apex; auth flow stays on that apex,
//     no cross-subdomain redirect to repair)
export function getAuthCookieDomain(req: Request | NextRequest): string | undefined {
  // Env unset or non-DNS (e.g. "localhost") → host-only cookies are the
  // safe fallback. Failing closed here would brick auth on preview deploys
  // and local dev. Do NOT change this to throw.
  const primaryDomain = process.env.PLATFORM_PRIMARY_DOMAIN ?? "";
  if (!primaryDomain || !primaryDomain.includes(".")) return undefined;

  // req.url is always a valid URL on NextRequest, but the helper accepts the
  // wider Request type so callers don't have to narrow. Keep the cast safe.
  let hostname: string;
  try {
    hostname = new URL(req.url).hostname;
  } catch {
    return undefined;
  }
  if (hostname === primaryDomain || hostname.endsWith(`.${primaryDomain}`)) {
    return `.${primaryDomain}`;
  }
  return undefined;
}

function withCookieDomain(options: CookieOptions, domain: string | undefined): CookieOptions {
  if (!domain) return options;
  return { ...options, domain };
}

export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

// Creates a Supabase client that authenticates via an explicit Bearer JWT
// rather than session cookies. All PostgREST queries carry the token so
// RLS applies under the user's identity. Call `supabase.auth.getUser(token)`
// (not the no-arg form) to verify the JWT against Supabase's auth server.
export function createBearerClient(token: string): SupabaseClient {
  const { url, anonKey } = supabaseAnonConfig();
  return createServerClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    cookies: { getAll: () => [], setAll: () => {} },
  });
}

export function createRequestScopedClient(req: Request): SupabaseClient {
  const { url, anonKey } = supabaseAnonConfig();
  const cookies = parseCookieHeader(req.headers.get("cookie"));
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookies,
      // No-op: proxy.ts owns refresh; this client only reads + verifies and has
      // no response to write Set-Cookie onto.
      setAll: () => {},
    },
  });
}

export function createRouteHandlerClient(req: NextRequest): {
  supabase: SupabaseClient;
  applyAuthCookies: <T extends NextResponse>(res: T) => T;
} {
  const { url, anonKey } = supabaseAnonConfig();
  const cookieDomain = getAuthCookieDomain(req);
  const pending: { name: string; value: string; options: CookieOptions }[] = [];
  const extraHeaders: Record<string, string> = {};

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const cookie of cookiesToSet) {
          pending.push({
            ...cookie,
            options: withCookieDomain(cookie.options, cookieDomain),
          });
        }
        Object.assign(extraHeaders, headers);
      },
    },
  });

  const applyAuthCookies = <T extends NextResponse>(res: T): T =>
    flushCapturedCookies(res, pending, extraHeaders);

  return { supabase, applyAuthCookies };
}

export function createMiddlewareClient(req: NextRequest): {
  supabase: SupabaseClient;
  applyRefreshedSession: <T extends NextResponse>(res: T) => T;
} {
  const { url, anonKey } = supabaseAnonConfig();
  const cookieDomain = getAuthCookieDomain(req);
  const pending: { name: string; value: string; options: CookieOptions }[] = [];
  const extraHeaders: Record<string, string> = {};

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const cookie of cookiesToSet) {
          // Forward the rotated token to the handler on this pass: NextRequest
          // cookie mutations show up in the Cookie header proxy.ts forwards.
          req.cookies.set(cookie.name, cookie.value);
          pending.push({
            ...cookie,
            options: withCookieDomain(cookie.options, cookieDomain),
          });
        }
        Object.assign(extraHeaders, headers);
      },
    },
  });

  // No-op unless getUser() actually refreshed (pending stays empty when the
  // access token is still valid), so steady-state responses are untouched.
  const applyRefreshedSession = <T extends NextResponse>(res: T): T =>
    flushCapturedCookies(res, pending, extraHeaders);

  return { supabase, applyRefreshedSession };
}

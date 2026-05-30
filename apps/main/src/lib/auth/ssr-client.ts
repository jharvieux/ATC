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
  const pending: { name: string; value: string; options: CookieOptions }[] = [];
  const extraHeaders: Record<string, string> = {};

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        pending.push(...cookiesToSet);
        Object.assign(extraHeaders, headers);
      },
    },
  });

  const applyAuthCookies = <T extends NextResponse>(res: T): T => {
    for (const { name, value, options } of pending) {
      res.cookies.set(toResponseCookie(name, value, options));
    }
    for (const [key, val] of Object.entries(extraHeaders)) {
      res.headers.set(key, val);
    }
    return res;
  };

  return { supabase, applyAuthCookies };
}

export function createMiddlewareClient(req: NextRequest): {
  supabase: SupabaseClient;
  applyRefreshedSession: <T extends NextResponse>(res: T) => T;
} {
  const { url, anonKey } = supabaseAnonConfig();
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
          pending.push(cookie);
        }
        Object.assign(extraHeaders, headers);
      },
    },
  });

  // No-op unless getUser() actually refreshed (pending stays empty when the
  // access token is still valid), so steady-state responses are untouched.
  const applyRefreshedSession = <T extends NextResponse>(res: T): T => {
    for (const { name, value, options } of pending) {
      res.cookies.set(toResponseCookie(name, value, options));
    }
    for (const [key, val] of Object.entries(extraHeaders)) {
      res.headers.set(key, val);
    }
    return res;
  };

  return { supabase, applyRefreshedSession };
}

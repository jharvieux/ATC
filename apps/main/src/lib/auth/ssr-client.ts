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
//   createMiddlewareClient(req, res) — read + write, used by proxy.ts. A token
//     refresh must write the rotated session to BOTH the request (so the
//     downstream handler sees the fresh token on this pass) and the response
//     (so the browser stores it). Supabase rotates the refresh token on every
//     use, so this is the ONLY place that refreshes — without it, sessions die
//     the first time the 1h access token expires.
//
//   createRequestScopedClient(req)  — read only. tenantContextFromRequest and
//     assertPermission resolve + verify the session (getUser) from the request
//     cookies. setAll is a no-op: the middleware owns refresh, and these
//     helpers run deep inside handlers where there is no response to write to.

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest, NextResponse } from "next/server";

// NEXT_PUBLIC_* are validated at boot (lib/env.ts) and inlined at build; the
// non-null assertions match the convention in the existing auth routes.
function supabaseAnonConfig(): { url: string; anonKey: string } {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  };
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

export function createMiddlewareClient(
  req: NextRequest,
  res: NextResponse,
): SupabaseClient {
  const { url, anonKey } = supabaseAnonConfig();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value, options } of cookiesToSet) {
          // Write to the request so a refresh is visible to the handler this
          // pass, and to the response so the browser stores the rotated tokens.
          req.cookies.set(name, value);
          res.cookies.set(toResponseCookie(name, value, options));
        }
        for (const [key, val] of Object.entries(headers)) {
          res.headers.set(key, val);
        }
      },
    },
  });
}

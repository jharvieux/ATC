// Request-scoped memoization of `supabase.auth.getUser()`. Wrap once
// with `React.cache` so multiple server-component callers in a single
// render tree share one network round-trip.
//
// Why this exists (#667): the (tenant)/layout calls
// getSiteHeaderProps() → getUser(), then the page beneath calls
// assertPermission() → getUser(). Without cache that's two cookie-
// parses + two Supabase JWT verifications per nav. With cache it's one.
//
// #679 closed the cross-helper doubling: assertPermission now reads
// the verified user from this cache too instead of doing its own
// supabase.auth.getUser() call. The `user` field carries the full
// Supabase User so assertPermission can consume `user.id` for the
// consent gate + tenant-membership lookups without re-verifying.

import { cache as reactCache } from "react";
import { headers } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import { tryTestBypass } from "@/lib/auth/test-bypass";

// React.cache is a server-only API; in vitest's node env it can be
// undefined depending on how `react` resolves. Outside production fall
// back to a passthrough so importing this module from tests that don't
// explicitly mock `react.cache` doesn't throw at module load time.
//
// In production the passthrough would SILENTLY revert to the 2x auth-
// call behavior #679 closed, with no observable failure. Throw loudly
// at module load if cache is missing in production so a future React/
// Next regression that removed the export is caught immediately.
type CacheFn = <T extends (...a: never[]) => unknown>(fn: T) => T;
const cache: CacheFn = (() => {
  if (typeof reactCache === "function") return reactCache as CacheFn;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "get-cached-user: react.cache is not a function in production. " +
        "This indicates a React/Next regression — request memoization " +
        "would silently break, doubling auth round-trips per page render.",
    );
  }
  // Non-production (test) — passthrough is fine; the dedicated test for
  // this module mocks react.cache directly when it needs to exercise
  // the real-cache invariant.
  return (fn) => fn;
})();

export interface CachedUserResult {
  /** True iff the lookup succeeded AND a session existed. */
  isAuthenticated: boolean;
  /**
   * The verified Supabase user, if the lookup succeeded. NULL for any
   * failure mode (no session, expired JWT, network error). Callers that
   * need to differentiate "anonymous" from "auth error" should re-read
   * the underlying client themselves — this cache deliberately collapses
   * both to NULL to match the established pattern in
   * resolve-post-login.ts and the original lazy-anonymous fallback.
   */
  user: User | null;
}

/**
 * Returns the verified user (or null) for the current request,
 * memoized for the remainder of the React render tree's lifetime.
 *
 * Behavior matches the established pattern in resolve-post-login.ts:
 * any error from getUser() (including the routine
 * AuthSessionMissingError for anonymous visitors) collapses to
 * `{ isAuthenticated: false, user: null }`. Env-misconfig still
 * throws upstream inside createRequestScopedClient.
 */
export const getCachedUser = cache(async (): Promise<CachedUserResult> => {
  const incoming = await headers();
  const forwarded = new Headers();
  const cookie = incoming.get("cookie");
  if (cookie) forwarded.set("cookie", cookie);
  const auth = incoming.get("authorization");
  if (auth) forwarded.set("authorization", auth);

  const placeholderReq = new Request("https://placeholder.internal/", {
    headers: forwarded,
  });

  // Local-CI bypass: the middleware already recognised the bypass Bearer and
  // set the resolved-tenant-id header; mirror that logic here so server
  // components see an authenticated user without needing GoTrue.
  // tryTestBypass guards against production use (NODE_ENV + VERCEL_ENV checks).
  const bypass = tryTestBypass(placeholderReq);
  if (bypass) {
    return {
      isAuthenticated: true,
      user: {
        id: bypass.auth_user_id,
        aud: "authenticated",
        role: "authenticated",
        email: "e2e-test@local",
        email_confirmed_at: "2024-01-01T00:00:00.000Z",
        phone: "",
        confirmed_at: "2024-01-01T00:00:00.000Z",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
        last_sign_in_at: "2024-01-01T00:00:00.000Z",
        app_metadata: {},
        user_metadata: {},
        identities: [],
        factors: [],
      } as User,
    };
  }

  const supabase = createRequestScopedClient(placeholderReq);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    return { isAuthenticated: false, user: null };
  }
  return { isAuthenticated: true, user: data.user };
});

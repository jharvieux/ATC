// Request-scoped memoization of `supabase.auth.getUser()`. Wrap once
// with `React.cache` so multiple server-component callers in a single
// render tree share one network round-trip.
//
// Why this exists (#667): the (tenant)/layout calls
// getSiteHeaderProps() → getUser(), then the page beneath calls
// assertPermission() → getUser(). Without cache that's two cookie-
// parses + two Supabase JWT verifications per nav. With cache it's one.
//
// SCOPE NOTE: today only `getSiteHeaderProps` uses this. Migrating
// `assertPermission` to use it too (tracked separately) would close
// the cross-helper doubling. Migrating assertPermission has wider
// blast radius — every protected route depends on it — so it ships in
// its own change.

import { cache } from "react";
import { headers } from "next/headers";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";

export interface CachedUserResult {
  /** True iff the lookup succeeded AND a session existed. */
  isAuthenticated: boolean;
  // NOTE: a `user: User` field belongs here once #679 migrates
  // assertPermission to this helper — that's the consumer that needs
  // the full User payload. Holding off pre-emptively per D-091
  // Pattern 11 (no stub-shaped fields with no current consumer).
}

/**
 * Returns whether the current request has an authenticated session,
 * memoized for the remainder of the React render tree's lifetime.
 *
 * Behavior matches the established pattern in resolve-post-login.ts:
 * any error from getUser() (including the routine
 * AuthSessionMissingError for anonymous visitors) collapses to
 * `{ isAuthenticated: false }`. Env-misconfig still throws upstream
 * inside createRequestScopedClient.
 */
export const getCachedUser = cache(async (): Promise<CachedUserResult> => {
  const incoming = await headers();
  const forwarded = new Headers();
  const cookie = incoming.get("cookie");
  if (cookie) forwarded.set("cookie", cookie);
  const supabase = createRequestScopedClient(
    new Request("https://placeholder.internal/", { headers: forwarded }),
  );
  const { data, error } = await supabase.auth.getUser();
  return { isAuthenticated: !error && data?.user != null };
});

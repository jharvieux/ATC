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
import type { User } from "@supabase/supabase-js";

export interface CachedUserResult {
  /** The Supabase auth user, or null if no valid session. */
  user: User | null;
  /** True iff the lookup succeeded AND a session existed. */
  isAuthenticated: boolean;
}

/**
 * Returns the current session's auth user (or null), memoized for the
 * remainder of the React render tree's lifetime.
 *
 * Behavior matches the established pattern in resolve-post-login.ts:
 * any error from getUser() (including the routine
 * AuthSessionMissingError for anonymous visitors) collapses to
 * `{ user: null, isAuthenticated: false }`. Env-misconfig still throws
 * upstream inside createRequestScopedClient.
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
  if (error || !data?.user) return { user: null, isAuthenticated: false };
  return { user: data.user, isAuthenticated: true };
});

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

// React.cache is a server-only API; in vitest's node env it can be
// undefined depending on how `react` resolves. Fall back to a
// passthrough so importing this module from tests that don't
// explicitly mock `react.cache` doesn't throw at module load time.
// Behavior is equivalent for single-call cases — only the cross-call
// sharing invariant requires the real cache, which is exercised by the
// dedicated get-cached-user.test that DOES mock react.
type CacheFn = <T extends (...a: never[]) => unknown>(fn: T) => T;
const cache: CacheFn = typeof reactCache === "function" ? (reactCache as CacheFn) : ((fn) => fn);

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
  const supabase = createRequestScopedClient(
    new Request("https://placeholder.internal/", { headers: forwarded }),
  );
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    return { isAuthenticated: false, user: null };
  }
  return { isAuthenticated: true, user: data.user };
});

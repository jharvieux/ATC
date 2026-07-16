// #1585 — Local JWT verification for the inner auth layers.
//
// The "auth tax": every authenticated API request used to pay THREE GoTrue
// network round-trips (proxy.ts getUser, factories.ts getUser, and
// assert-permission's getCachedUser) re-verifying an identity that was
// confirmed milliseconds earlier in the same request.
//
// WHY THIS IS NOT A TRUST REGRESSION (the important part):
//
// The obvious "fix" — have the middleware forward its verified user id in an
// internal header and let the inner layers trust it — is REJECTED. It fails
// closed nowhere: /api/auth/* is exempt from the middleware's getUser() (see
// proxy.ts §1b), yet several of those routes call assertPermission. A
// forwarded-header scheme would hand those routes an unverified identity, and
// the whole design would rest on header-stripping being airtight forever.
//
// Instead every layer keeps verifying the JWT cryptographically — it just does
// it LOCALLY. supabase.auth.getClaims() checks the ES256 signature against the
// project's JWKS with WebCrypto, and rejects `exp` in the past. A forged or
// expired token fails here exactly as it failed against GoTrue. What changes is
// the transport (a local signature check instead of an HTTP call), not the
// trust decision.
//
// The JWKS itself is fetched from the auth server and cached in auth-js's
// module-global GLOBAL_JWKS (keyed by storageKey, 10-minute TTL), so the cache
// survives the per-request client instances this codebase creates and the
// steady-state cost is zero network calls. The keys are PUBLIC — caching them
// grants no authority; only the signature check does.
//
// FAIL-CLOSED (D-091 #2): every failure mode — no session, bad signature,
// expired token, malformed claims, JWKS unreachable on a cold cache — returns
// null. Callers throw. There is no path here that returns an identity without
// a verified signature behind it.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export interface VerifiedIdentity {
  /** auth.users.id — the `sub` claim of a signature-verified JWT. */
  authUserId: string;
  /**
   * The signature-verified claims payload. Callers that need claims beyond
   * `sub` (e.g. the §26.3 `auth_time` re-auth check) read them from HERE —
   * these are the exact bytes getClaims() verified, so there is no re-read
   * seam between "the token that was verified" and "the claims that are used".
   */
  claims: Record<string, unknown>;
}

/**
 * Cryptographically verifies the request's JWT and returns the identity it
 * asserts, or null if verification fails for any reason.
 *
 * `token` — pass the explicit bearer JWT for Authorization-header callers.
 * Omit it for cookie-session callers; getClaims() then pulls the access token
 * from the client's cookie-backed session and verifies THAT.
 */
export async function verifyIdentity(
  supabase: SupabaseClient,
  token?: string,
): Promise<VerifiedIdentity | null> {
  // getClaims() verifies the signature against the JWKS. On a project using a
  // symmetric (legacy HS256) key, or where WebCrypto is unavailable, auth-js
  // internally falls back to a getUser() network call rather than trusting the
  // payload — so this helper stays correct (just slower) on such a project
  // instead of silently degrading into an unverified decode.
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims) return null;

  const claims = data.claims as unknown as Record<string, unknown>;
  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;

  // Return the verified claims directly. Earlier this helper re-read the
  // session (a second getSession()) to hand back the raw token bytes, but
  // that opened a seam: auth-js may rotate the token between the getClaims()
  // verification and that re-read, so the returned bytes weren't provably the
  // verified ones. `claims` IS the verified payload — callers read auth_time
  // from it, so the "exact bytes verified" guarantee is now structural (#1939).
  return { authUserId: sub, claims };
}

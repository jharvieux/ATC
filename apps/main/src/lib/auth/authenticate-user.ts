// §17.4 / §17.9 / §17.10 — Canonical identity prelude for the user-self routes
// (consent acceptance + CCPA data export/delete/undo).
//
// These routes deliberately do NOT go through assertPermission: the consent
// gate inside assertPermission throws ConsentPendingError, which would deadlock
// the very endpoints a user needs to clear a pending-consent block. They also
// run their mutations under the service-role client (RLS bypassed), so identity
// must be established explicitly here. Before this helper, five routes each
// copied an ~18-line anon-client + getUser() prelude and the copies drifted
// (401 vs silent 200; #1591).
//
// Accepts EITHER an Authorization: Bearer JWT (browser extension / iOS Shortcut)
// OR the HttpOnly session cookie (browser), mirroring assertPermission's dual
// path. Exactly one GoTrue round-trip. Returns null on missing/invalid auth so
// every caller returns a consistent 401.

import {
  createBearerClient,
  createRequestScopedClient,
  extractBearerToken,
} from "./ssr-client";

export interface AuthenticatedUser {
  authUserId: string;
  email: string | null;
}

export async function authenticateUser(
  req: Request,
): Promise<AuthenticatedUser | null> {
  const token = extractBearerToken(req);

  // Bearer path: createBearerClient sets the Authorization header globally;
  // getUser(token) verifies that exact JWT against GoTrue (the ssr-client
  // contract — the no-arg form would look for a cookie session that a bearer
  // client never has).
  if (token) {
    const supabase = createBearerClient(token);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return { authUserId: data.user.id, email: data.user.email ?? null };
  }

  // Cookie path: verify the HttpOnly session against GoTrue.
  const supabase = createRequestScopedClient(req);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return { authUserId: data.user.id, email: data.user.email ?? null };
}

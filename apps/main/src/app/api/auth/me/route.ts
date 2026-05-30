// §7.1 — Current user identity + consent state.
//
// GET /api/auth/me
//
// Used by the client to render the profile menu and to discover pending
// consent (so it can route to /consent). When consent IS pending,
// assertPermission throws ConsentPendingError — we catch it here and
// return a 200 with the pending list, because /me is the read-side
// endpoint clients use to *discover* the state; if /me itself returned
// 403, the client couldn't find out which docs to surface.

import { assertPermission, ConsentPendingError } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";

export async function GET(req: Request): Promise<Response> {
  try {
    const { user } = await assertPermission(req, {
      resource: "me",
      action: "get",
    });

    // Past the consent gate — pull the display fields. RLS on `users`
    // permits a user to SELECT their own row by auth_user_id. The
    // assertPermission call above instantiates its own request-scoped
    // client; we open a second one here for the profile read. Acceptable
    // — both are cheap cookie-parse + same-cookie SELECTs — but a future
    // refactor that has assertPermission return the client would let us
    // drop the second instantiation.
    const supabase = createRequestScopedClient(req);
    const { data: row, error: rowErr } = await supabase
      .from("users")
      .select("email, first_name, last_name")
      .eq("auth_user_id", user.auth_user_id)
      .eq("tenant_id", user.tenant_id)
      .maybeSingle();
    // Fail loud on a DB error — @supabase/supabase-js v2 does not throw,
    // and a swallowed error would 200 with null display fields and look
    // like "user has no profile" instead of "the DB is broken."
    if (rowErr) {
      throw new Error(`me: users profile lookup failed: ${rowErr.message}`);
    }
    const profile = row as
      | { email: string | null; first_name: string | null; last_name: string | null }
      | null;

    return Response.json({
      user_id: user.id,
      auth_user_id: user.auth_user_id,
      tenant_id: user.tenant_id,
      role: user.role,
      email: profile?.email ?? null,
      first_name: profile?.first_name ?? null,
      last_name: profile?.last_name ?? null,
      // Always [] here: assertPermission throws ConsentPendingError above
      // before we reach this branch if any consents are pending. The
      // catch block below surfaces those when present.
      consent_pending: [],
    });
  } catch (err) {
    if (err instanceof ConsentPendingError) {
      return Response.json({
        user_id: null,
        consent_pending: err.pending,
        return_to: err.return_to,
      });
    }
    return respondToAuthError(err);
  }
}

// §18.7 — RSVP state update (form-submit and JSON handler from the invitee page).
//
// Audit pass 2, Finding 4: when a token has been "bound" to a specific
// authenticated email (first GET sets `token_bound_email`), subsequent
// RSVP changes must come from that same email. Otherwise a leaked invite
// link (forwarded email, shared screen) could flip the RSVP state and
// poison cabin-grid totals after the legitimate invitee already claimed it.

import { parseAndVerifyHmac } from "@/lib/groups/invitation-token";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { createClient } from "@supabase/supabase-js";

const VALID_RSVP = new Set(["pending", "interested", "not_going", "booked"]);

async function authenticatedEmail(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const accessToken = authHeader.slice("Bearer ".length);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const sb = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user?.email) return null;
  return data.user.email.toLowerCase();
}

export async function POST(req: Request, props: { params: Promise<{ token: string }> }): Promise<Response> {
  const params = await props.params;
  const contentType = req.headers.get("content-type") ?? "";
  let rsvp_state: string | null = null;

  if (contentType.includes("application/json")) {
    const body = await req.json() as { rsvp_state?: string };
    rsvp_state = body.rsvp_state ?? null;
  } else {
    const form = await req.formData();
    rsvp_state = form.get("rsvp_state") as string | null;
  }

  if (!rsvp_state || !VALID_RSVP.has(rsvp_state)) {
    return Response.json({ error: "Invalid rsvp_state" }, { status: 400 });
  }

  const { invitation_id, ok } = parseAndVerifyHmac(params.token);
  if (!ok) return Response.json({ error: "invalid_token" }, { status: 400 });

  const svc = createServiceRoleClient();

  // Token-bound-email check: mirror the GET handler. If the token has
  // already been bound to an email, the caller must present a session for
  // that email. Unbound tokens (first use) skip this check.
  //
  // Also pull group_id so we can apply §18.10 sailed read-only gate below.
  const { data: invitationRow } = await svc
    .from("invitations")
    .select("token_bound_email, group_id")
    .eq("id", invitation_id)
    .maybeSingle();
  const inv = invitationRow as { token_bound_email?: string | null; group_id?: string } | null;
  const bound = inv?.token_bound_email ?? null;
  if (bound) {
    const callerEmail = await authenticatedEmail(req);
    if (!callerEmail || callerEmail !== bound.toLowerCase()) {
      return Response.json({ error: "token_bound_to_different_email" }, { status: 403 });
    }
  }

  // §18.10 — RSVP edits blocked once the group has sailed. Public route has no
  // tenant ctx, so the sailed check is inlined: one group read with both PK and
  // tenant_id (derived from the group row itself; invitation has no tenant_id column).
  if (inv?.group_id) {
    // d091-allow:service-role-tenant — public HMAC-verified invite route; tenant_id
    // scoped by reading group with its own PK, which is validated by the HMAC token chain.
    const { data: groupRow, error: gErr } = await svc
      .from("groups")
      .select("status, sailed_at, tenant_id")
      .eq("id", inv.group_id)
      .maybeSingle();
    if (gErr) {
      return Response.json({ error: "group_sailed_lookup_failed" }, { status: 500 });
    }
    if (!groupRow) {
      return Response.json({ error: "group_sailed_lookup_failed" }, { status: 500 });
    }
    const g = groupRow as { status: string; sailed_at: string | null; tenant_id: string };
    if (g.status === "sailed") {
      return Response.json(
        { error: "group_sailed", sailed_at: g.sailed_at, message: "This trip has sailed. RSVP changes are no longer accepted." },
        { status: 410 },
      );
    }
  }

  try {
    await safeAwait(
      // d091-allow:service-role-tenant — public invite route; HMAC-verified invitation_id, no tenant ctx.
      svc.from("invitations").update({ rsvp_state }).eq("id", invitation_id).is("token_revoked_at", null),
      "invitations.rsvp_update",
    );
  } catch {
    return Response.json({ error: "rsvp_update_failed" }, { status: 500 });
  }

  // If form submission, redirect back to the invitee page.
  if (!contentType.includes("application/json")) {
    const origin = new URL(req.url).origin;
    return Response.redirect(`${origin}/group/invite/${params.token}?rsvp=updated`, 302);
  }

  return Response.json({ ok: true, rsvp_state });
}

// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// §18.5 — Five-check invitation token validation contract.
//
// GET /api/groups/invite/[token]
//   Returns invitation details (group, coordinator message, cabin grid preview)
//   or an error describing which check failed and why.
//
// PATCH /api/groups/invite/[token]  { rsvp_state, visibility_choice? }
//   Updates the invitee's RSVP for this invitation.

import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { parseAndVerifyHmac } from "@/lib/groups/invitation-token";
import { effectiveVisibility } from "@/lib/groups/visibility";

interface Invitation {
  id: string;
  group_id: string;
  invitee_email: string;
  invitee_name: string | null;
  rsvp_state: string;
  visibility_choice: "no_opinion" | "be_anonymous" | "show_me_anyway";
  token_revoked_at: string | null;
  token_revoked_reason: string | null;
  token_first_used_at: string | null;
  token_bound_email: string | null;
}

interface Group {
  id: string;
  status: string;
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  departure_port: string;
  coordinator_message: string | null;
  visibility_default: "visible" | "hidden";
  hero_image_url: string | null;
}

type RouteProps = { params: { token: string } };

export async function GET(req: Request, { params }: RouteProps): Promise<Response> {
  const { token } = params;

  // Check 1 — HMAC signature valid.
  const { invitation_id, ok } = parseAndVerifyHmac(token);
  if (!ok) {
    return Response.json({ error: "invalid_token", message: "This invitation link is invalid. Please contact the trip coordinator for a new one." }, { status: 400 });
  }

  const svc = createServiceRoleClient();

  // Check 2 — Token exists.
  const { data: inv, error: invErr } = await svc
    .from("invitations")
    .select("id,group_id,invitee_email,invitee_name,rsvp_state,visibility_choice,token_revoked_at,token_revoked_reason,token_first_used_at,token_bound_email")
    .eq("id", invitation_id)
    .maybeSingle();

  if (invErr || !inv) {
    return Response.json({ error: "invalid_token", message: "This invitation link is invalid. Please contact the trip coordinator for a new one." }, { status: 400 });
  }

  const invitation = inv as Invitation;

  // Check 3 — Token not revoked.
  if (invitation.token_revoked_at) {
    const reason = invitation.token_revoked_reason ?? "expired_natural";
    const messages: Record<string, string> = {
      invitee_removed: "You have been removed from this trip invitation.",
      coordinator_revoked: "This invitation has been revoked by the trip coordinator.",
      suspected_compromise: "This invitation link has been deactivated for security reasons. Please contact the coordinator.",
      expired_natural: "This invitation link has expired.",
      first_use_authenticated: "This invitation is already bound to another account.",
    };
    return Response.json({ error: "token_revoked", reason, message: messages[reason] ?? "This invitation is no longer valid." }, { status: 410 });
  }

  // Fetch parent group.
  const { data: group, error: groupErr } = await svc
    .from("groups")
    .select("id,status,cruise_line,ship_name,sailing_date,departure_port,coordinator_message,visibility_default,hero_image_url")
    .eq("id", invitation.group_id)
    .single();

  if (groupErr || !group) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const grp = group as Group;

  // Check 4 — Not naturally expired (sailing_date + 30 days).
  const sailDate = new Date(grp.sailing_date);
  const expiry = new Date(sailDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (new Date() > expiry) {
    // Lazy-set expired_natural.
    await svc.from("invitations").update({
      token_revoked_at: new Date().toISOString(),
      token_revoked_reason: "expired_natural",
    }).eq("id", invitation_id);
    return Response.json({ error: "token_revoked", reason: "expired_natural", message: "This invitation link has expired." }, { status: 410 });
  }

  // Check 5 — First-use binding.
  const authHeader = req.headers.get("authorization");
  let currentEmail: string | null = null;
  if (authHeader?.startsWith("Bearer ")) {
    const anonClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: authData } = await anonClient.auth.getUser();
    currentEmail = authData?.user?.email ?? null;
  }

  if (invitation.token_first_used_at === null) {
    // First use — record it.
    const updates: Record<string, string | null> = { token_first_used_at: new Date().toISOString() };
    if (currentEmail) updates.token_bound_email = currentEmail;
    await svc.from("invitations").update(updates).eq("id", invitation_id);
  } else if (invitation.token_bound_email && currentEmail && invitation.token_bound_email !== currentEmail) {
    return Response.json({
      error: "token_bound",
      message: "This invitation link is already linked to a different account. Each invitation is personal.",
    }, { status: 403 });
  }

  // Build cabin grid (respects anonymity per §18.6).
  const { data: allInvitations } = await svc
    .from("invitations")
    .select("rsvp_state,visibility_choice,invitee_name")
    .eq("group_id", grp.id);

  const cabinGrid = buildCabinGrid(grp, allInvitations as Invitation[] ?? []);

  return Response.json({
    invitation: {
      id: invitation.id,
      rsvp_state: invitation.rsvp_state,
      visibility_choice: invitation.visibility_choice,
    },
    group: {
      id: grp.id,
      status: grp.status,
      cruise_line: grp.cruise_line,
      ship_name: grp.ship_name,
      sailing_date: grp.sailing_date,
      departure_port: grp.departure_port,
      coordinator_message: grp.coordinator_message,
      hero_image_url: grp.hero_image_url,
    },
    cabin_grid: cabinGrid,
  });
}

export async function PATCH(req: Request, { params }: RouteProps): Promise<Response> {
  const { token } = params;
  const { invitation_id, ok } = parseAndVerifyHmac(token);
  if (!ok) return Response.json({ error: "invalid_token" }, { status: 400 });

  const body = await req.json() as { rsvp_state?: string; visibility_choice?: string };
  const { rsvp_state, visibility_choice } = body;

  const VALID_RSVP = new Set(["pending", "interested", "not_going", "booked"]);
  const VALID_VIS = new Set(["no_opinion", "be_anonymous", "show_me_anyway"]);

  if (rsvp_state && !VALID_RSVP.has(rsvp_state)) {
    return Response.json({ error: "Invalid rsvp_state" }, { status: 400 });
  }
  if (visibility_choice && !VALID_VIS.has(visibility_choice)) {
    return Response.json({ error: "Invalid visibility_choice" }, { status: 400 });
  }

  const svc = createServiceRoleClient();

  // Audit pass 2, Finding 4: enforce token-binding here too. If the token
  // has been bound to an authenticated email by a prior GET (line 119),
  // a subsequent PATCH must come from a session for that same email.
  const { data: invitationRow } = await svc
    .from("invitations")
    .select("token_bound_email")
    .eq("id", invitation_id)
    .maybeSingle();
  const bound =
    (invitationRow as { token_bound_email?: string | null } | null)?.token_bound_email ?? null;
  if (bound) {
    const authHeader = req.headers.get("authorization");
    let callerEmail: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      const accessToken = authHeader.slice("Bearer ".length);
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (url && anon) {
        const sb = (await import("@supabase/supabase-js")).createClient(url, anon, {
          auth: { autoRefreshToken: false, persistSession: false },
          global: { headers: { Authorization: `Bearer ${accessToken}` } },
        });
        const { data: userData } = await sb.auth.getUser();
        callerEmail = userData?.user?.email?.toLowerCase() ?? null;
      }
    }
    if (!callerEmail || callerEmail !== bound.toLowerCase()) {
      return Response.json({ error: "token_bound_to_different_email" }, { status: 403 });
    }
  }

  const updates: Record<string, string> = {};
  if (rsvp_state) updates.rsvp_state = rsvp_state;
  if (visibility_choice) updates.visibility_choice = visibility_choice;

  const { error } = await svc.from("invitations").update(updates).eq("id", invitation_id).is("token_revoked_at", null);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ ok: true });
}

function buildCabinGrid(group: Group, invitations: Invitation[]): { booked: number; interested: number; pending: number; not_going: number } {
  const counts = { booked: 0, interested: 0, pending: 0, not_going: 0 };
  for (const inv of invitations) {
    const vis = effectiveVisibility(group.visibility_default, inv.visibility_choice);
    if (vis === "hidden") continue; // hidden invitees contribute to counts but names are omitted
    const state = inv.rsvp_state as keyof typeof counts;
    if (state in counts) counts[state]++;
  }
  return counts;
}

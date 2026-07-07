// §18.5 — Five-check invitation token validation contract.
//
// GET /api/groups/invite/[token]
//   Returns invitation details (group, coordinator message, cabin grid preview)
//   or an error describing which check failed and why.
//
// PATCH /api/groups/invite/[token]  { rsvp_state, visibility_choice? }
//   Updates the invitee's RSVP for this invitation.

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { parseAndVerifyHmac } from "@/lib/groups/invitation-token";
import { effectiveVisibility } from "@/lib/groups/visibility";
import { deriveDisplayName, avatarColorForId } from "@/lib/groups/roster";
import { safeAwait } from "@/lib/db/safe-mutation";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export interface Invitation {
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

export interface Group {
  id: string;
  status: string;
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  departure_port: string;
  coordinator_message: string | null;
  visibility_default: "visible" | "hidden";
  hero_image_url: string | null;
  sailing_id: string | null;
  tenant_id: string;
}

export interface ItineraryStop {
  dayLabel: string;
  portName: string;
  arrival: string | null;
  departure: string | null;
  isSeaDay: boolean;
}

interface ShipStats {
  guestCapacity: number | null;
  decks: number | null;
  builtYear: number | null;
  signatureFeature: string | null;
}

export interface RosterEntry {
  id: string;
  displayName: string;
  anonymous: boolean;
  avatarColor: string;
  status: "booked" | "interested" | "pending" | "not_going";
}

interface ChatMessagePreview {
  id: string;
  authorName: string;
  text: string;
  timestamp: string;
}

interface ChatPreview {
  messages: ChatMessagePreview[];
  totalThisWeek: number;
}

type RouteProps = { params: Promise<{ token: string }> };

export async function GET(req: Request, props: RouteProps): Promise<Response> {
  const params = await props.params;
  const { token } = params;

  // Check 1 — HMAC signature valid.
  const { invitation_id, ok } = await parseAndVerifyHmac(token);
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
    .select("id,status,cruise_line,ship_name,sailing_date,departure_port,coordinator_message,visibility_default,hero_image_url,sailing_id,tenant_id")
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
    await safeAwait(svc.from("invitations").update({
      token_revoked_at: new Date().toISOString(),
      token_revoked_reason: "expired_natural",
    }).eq("id", invitation_id), "invitations.update");
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

  // Greptile audit-followups round-2 #54: first-use binding TOCTOU.
  // Two concurrent GETs both see token_first_used_at=null, both write, last
  // writer wins on token_bound_email — locking the legitimate first-user out.
  // Fix: CAS update predicated on token_first_used_at still being null.
  // If the row count is zero we lost the race; re-fetch the row to see who
  // won and apply the not-first-use branch with the now-bound email.
  if (invitation.token_first_used_at === null) {
    const updates: Record<string, string | null> = { token_first_used_at: new Date().toISOString() };
    if (currentEmail) updates.token_bound_email = currentEmail;
    const winRows = await safeAwait(
      svc.from("invitations")
        .update(updates)
        .eq("id", invitation_id)
        .is("token_first_used_at", null)
        .select("id, token_bound_email"),
      "invitations.first_use_cas",
    );
    const winArr = winRows as Array<{ id: string; token_bound_email: string | null }> | null;
    if (!winArr || winArr.length === 0) {
      // Lost the race. Re-read the invitation to see the winner's bound email.
      // Fail CLOSED on read error: never silently let a caller through when we
      // can't verify the bound email — would defeat the entire CAS guard.
      const { data: refetch, error: refetchError } = await svc
        .from("invitations")
        .select("token_bound_email")
        .eq("id", invitation_id)
        .maybeSingle();
      if (refetchError) return dbErrorResponse(refetchError);
      const boundEmail = (refetch as { token_bound_email: string | null } | null)?.token_bound_email ?? null;
      if (boundEmail && currentEmail && boundEmail !== currentEmail) {
        return Response.json({
          error: "token_bound",
          message: "This invitation link is already linked to a different account. Each invitation is personal.",
        }, { status: 403 });
      }
      // Same email or no-auth caller — let them through into the not-first-use branch.
    }
  } else if (invitation.token_bound_email && currentEmail && invitation.token_bound_email !== currentEmail) {
    return Response.json({
      error: "token_bound",
      message: "This invitation link is already linked to a different account. Each invitation is personal.",
    }, { status: 403 });
  }

  // Build cabin grid + roster (respects anonymity per §18.6).
  const { data: allInvitations } = await svc
    .from("invitations")
    .select("id,rsvp_state,visibility_choice,invitee_name")
    .eq("group_id", grp.id);

  const invitationRows = (allInvitations as (Invitation & { id: string })[] | null) ?? [];
  const cabinGrid = buildCabinGrid(invitationRows);
  const roster = buildRoster(grp, invitationRows);

  const { itinerary, shipStats } = grp.sailing_id
    ? await fetchItineraryAndShipStats(svc, grp.sailing_id)
    : { itinerary: null, shipStats: null };

  const chatPreview = await fetchChatPreview(svc, grp.id, grp.tenant_id);

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
    roster,
    itinerary,
    ship_stats: shipStats,
    chat_preview: chatPreview,
  });
}

export async function PATCH(req: Request, props: RouteProps): Promise<Response> {
  const params = await props.params;
  const { token } = params;
  const { invitation_id, ok } = await parseAndVerifyHmac(token);
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
  if (error) return dbErrorResponse(error);

  return Response.json({ ok: true });
}

export function buildCabinGrid(invitations: Invitation[]): { booked: number; interested: number; pending: number; not_going: number } {
  // Anonymity (§18.6) hides a name from the roster, not the person from the
  // count — every invitee counts here regardless of visibility.
  const counts = { booked: 0, interested: 0, pending: 0, not_going: 0 };
  for (const inv of invitations) {
    const state = inv.rsvp_state as keyof typeof counts;
    if (state in counts) counts[state]++;
  }
  return counts;
}

export function buildRoster(group: Group, invitations: (Invitation & { id: string })[]): RosterEntry[] {
  const roster: RosterEntry[] = [];
  for (const inv of invitations) {
    const state = inv.rsvp_state;
    if (state !== "booked" && state !== "interested" && state !== "pending" && state !== "not_going") continue;
    const anonymous = effectiveVisibility(group.visibility_default, inv.visibility_choice) === "hidden";
    roster.push({
      id: inv.id,
      displayName: anonymous ? "Anonymous" : deriveDisplayName(inv.invitee_name),
      anonymous,
      avatarColor: avatarColorForId(inv.id),
      status: state,
    });
  }
  return roster;
}

// Main's sailing_port_calls carries only port_name + day_index (copied
// verbatim from RAG's ports_of_call array, D-303) — no arrival/departure
// times and no dedicated sea-day flag. Arrival/departure stay null (spec:
// omit rather than fabricate); sea-day is a best-effort text heuristic since
// that's genuinely all the schema has today.
const SEA_DAY_PATTERN = /at sea|cruising|scenic/i;

export function toItineraryStop(row: { port_name: string; day_index: number }): ItineraryStop {
  return {
    dayLabel: `Day ${row.day_index + 1}`,
    portName: row.port_name,
    arrival: null,
    departure: null,
    isSeaDay: SEA_DAY_PATTERN.test(row.port_name),
  };
}

async function fetchItineraryAndShipStats(
  svc: SupabaseClient,
  sailingId: string,
): Promise<{ itinerary: ItineraryStop[]; shipStats: ShipStats | null }> {
  const { data: sailing } = await svc
    // d091-allow:service-role-tenant — PLATFORM_READABLE catalog table (no tenant_id column, D-231); sailingId came from the group row this public HMAC-verified route already resolved.
    .from("cruise_sailings")
    .select("cruise_ship_id")
    .eq("id", sailingId)
    .maybeSingle();

  const { data: stops } = await svc
    // d091-allow:service-role-tenant — same PLATFORM_READABLE catalog, scoped by sailingId from the already-resolved group.
    .from("sailing_port_calls")
    .select("port_name, day_index")
    .eq("sailing_id", sailingId)
    .order("day_index", { ascending: true });

  const itinerary = ((stops ?? []) as { port_name: string; day_index: number }[]).map(toItineraryStop);

  let shipStats: ShipStats | null = null;
  const cruiseShipId = (sailing as { cruise_ship_id?: string } | null)?.cruise_ship_id;
  if (cruiseShipId) {
    const { data: ship } = await svc
      .from("cruise_ships")
      .select("guest_capacity, decks, built_year, signature_feature")
      .eq("id", cruiseShipId)
      .maybeSingle();
    if (ship) {
      const s = ship as { guest_capacity: number | null; decks: number | null; built_year: number | null; signature_feature: string | null };
      shipStats = {
        guestCapacity: s.guest_capacity,
        decks: s.decks,
        builtYear: s.built_year,
        signatureFeature: s.signature_feature,
      };
    }
  }

  return { itinerary, shipStats };
}

async function fetchChatPreview(svc: SupabaseClient, groupId: string, tenantId: string): Promise<ChatPreview | null> {
  const { data: forum } = await svc
    .from("forums")
    .select("id")
    .eq("group_id", groupId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const forumId = (forum as { id?: string } | null)?.id;
  if (!forumId) return null;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recent } = await svc
    .from("forum_messages")
    .select("id, content, created_at, users(display_name, first_name, last_name)")
    .eq("forum_id", forumId)
    .eq("tenant_id", tenantId)
    .eq("status", "visible")
    .order("created_at", { ascending: false })
    .limit(2);

  const { count } = await svc
    .from("forum_messages")
    .select("id", { count: "exact", head: true })
    .eq("forum_id", forumId)
    .eq("tenant_id", tenantId)
    .eq("status", "visible")
    .gte("created_at", weekAgo);

  type MessageRow = {
    id: string;
    content: string;
    created_at: string;
    users?: { display_name: string | null; first_name: string | null; last_name: string | null } | { display_name: string | null; first_name: string | null; last_name: string | null }[] | null;
  };

  const messages: ChatMessagePreview[] = ((recent ?? []) as MessageRow[]).map((row) => {
    const rel = row.users;
    const user = Array.isArray(rel) ? rel[0] : rel;
    // Always truncate to first-name + last-initial, matching the roster's
    // anonymity posture — this preview is visible to anyone holding the
    // invite token, unauthenticated, and users.display_name is a free-text
    // profile field that isn't guaranteed to already be truncated.
    const fullName = user?.display_name || [user?.first_name, user?.last_name].filter(Boolean).join(" ") || null;
    const authorName = deriveDisplayName(fullName);
    return { id: row.id, authorName, text: row.content, timestamp: row.created_at };
  });

  return { messages, totalThisWeek: count ?? 0 };
}

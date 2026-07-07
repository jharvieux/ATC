// §18.5/§19.x — Shared checks 1-4 of the invitation-token validation
// contract (HMAC valid → invitation exists → not revoked → not naturally
// expired), factored out of app/api/groups/invite/[token]/route.ts so the
// new guest-facing forum routes don't re-derive the same error shapes.
//
// Deliberately excludes check 5 (first-use email binding): that check exists
// to bind a token to a login session once one occurs, and the anonymous
// forum flow has no login/session concept at all (spec: token-only access,
// isolated purely by the HMAC → invitation_id → group_id chain). A future
// session-aware forum feature would need to add it back explicitly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { parseAndVerifyHmac } from "@/lib/groups/invitation-token";
import { safeAwait } from "@/lib/db/safe-mutation";

export interface CheckedInvitation {
  id: string;
  group_id: string;
  rsvp_state: string;
  visibility_choice: "no_opinion" | "be_anonymous" | "show_me_anyway";
}

export interface CheckedGroup {
  id: string;
  status: string;
  sailed_at: string | null;
  sailing_date: string;
  visibility_default: "visible" | "hidden";
  tenant_id: string;
}

export type TokenCheckResult =
  | { ok: true; svc: SupabaseClient; invitation: CheckedInvitation; group: CheckedGroup }
  | { ok: false; response: Response };

const REVOKED_MESSAGES: Record<string, string> = {
  invitee_removed: "You have been removed from this trip invitation.",
  coordinator_revoked: "This invitation has been revoked by the trip coordinator.",
  suspected_compromise: "This invitation link has been deactivated for security reasons. Please contact the coordinator.",
  expired_natural: "This invitation link has expired.",
  first_use_authenticated: "This invitation is already bound to another account.",
};

export async function validateInviteTokenChecks1to4(token: string): Promise<TokenCheckResult> {
  // Check 1 — HMAC signature valid.
  const { invitation_id, ok } = await parseAndVerifyHmac(token);
  if (!ok) {
    return {
      ok: false,
      response: Response.json(
        { error: "invalid_token", message: "This invitation link is invalid. Please contact the trip coordinator for a new one." },
        { status: 400 },
      ),
    };
  }

  const svc = createServiceRoleClient();

  // Check 2 — Token exists.
  const { data: inv, error: invErr } = await svc
    // d091-allow:service-role-tenant — public HMAC-verified route; invitations has no tenant_id column, isolation is the HMAC-verified invitation_id itself.
    .from("invitations")
    .select("id,group_id,rsvp_state,visibility_choice,token_revoked_at,token_revoked_reason")
    .eq("id", invitation_id)
    .maybeSingle();

  if (invErr || !inv) {
    return {
      ok: false,
      response: Response.json(
        { error: "invalid_token", message: "This invitation link is invalid. Please contact the trip coordinator for a new one." },
        { status: 400 },
      ),
    };
  }

  const invitation = inv as CheckedInvitation & { token_revoked_at: string | null; token_revoked_reason: string | null };

  // Check 3 — Token not revoked.
  if (invitation.token_revoked_at) {
    const reason = invitation.token_revoked_reason ?? "expired_natural";
    return {
      ok: false,
      response: Response.json(
        { error: "token_revoked", reason, message: REVOKED_MESSAGES[reason] ?? "This invitation is no longer valid." },
        { status: 410 },
      ),
    };
  }

  const { data: group, error: groupErr } = await svc
    // d091-allow:service-role-tenant — public HMAC-verified route; group_id came from the HMAC-verified invitation above, tenant_id isn't known until this row is read.
    .from("groups")
    .select("id,status,sailed_at,sailing_date,visibility_default,tenant_id")
    .eq("id", invitation.group_id)
    .maybeSingle();

  if (groupErr || !group) {
    return { ok: false, response: Response.json({ error: "not_found" }, { status: 404 }) };
  }

  const grp = group as CheckedGroup;

  // Check 4 — Not naturally expired (sailing_date + 30 days).
  const sailDate = new Date(grp.sailing_date);
  const expiry = new Date(sailDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (new Date() > expiry) {
    await safeAwait(
      svc
        // d091-allow:service-role-tenant — public HMAC-verified route; lazy-revoke of the same HMAC-verified invitation_id, no tenant ctx available here.
        .from("invitations")
        .update({ token_revoked_at: new Date().toISOString(), token_revoked_reason: "expired_natural" })
        .eq("id", invitation_id),
      "invitations.update",
    );
    return {
      ok: false,
      response: Response.json(
        { error: "token_revoked", reason: "expired_natural", message: "This invitation link has expired." },
        { status: 410 },
      ),
    };
  }

  return { ok: true, svc, invitation, group: grp };
}

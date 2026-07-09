// #1654 — per-endpoint frequency gate for the single-invite action of
// POST /api/groups/[id]/invitations.
//
// group_invitation email sends intentionally bypass the general per-send
// throttle (email/rate-limit.ts returns allowed:true for the category), and
// the only other frequency cap is the reminder cron. That leaves the initial
// single-invite endpoint ungated: a coordinator could rapid-fire invites to
// many unique addresses (each escaping the dedup index, which only blocks a
// repeat to the SAME address), a revoke→reinvite spam vector.
//
// Shared store = the invitations table itself (DB, not a module-level Map), so
// the limit holds across serverless instances (D-091 #19). Counts ALL rows
// created in the window regardless of revoke state, so churning revoke→reinvite
// still counts toward the cap. Fail-closed: a count-query error denies.

import type { SupabaseClient } from "@supabase/supabase-js";

export const INVITE_WINDOW_SECONDS = 5 * 60;
export const INVITE_MAX_PER_WINDOW = 5;

export interface InviteFrequencyResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export async function checkInviteFrequency(
  svc: SupabaseClient,
  groupId: string,
): Promise<InviteFrequencyResult> {
  const windowStart = new Date(Date.now() - INVITE_WINDOW_SECONDS * 1000).toISOString();

  const { count, error } = await svc
    // d091-allow:service-role-tenant — invitations has no tenant_id column; group_id is verified against ctx.tenant_id by the caller before this runs.
    .from("invitations")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .gte("created_at", windowStart);

  // Fail closed: if we can't read the recent-invite count we can't prove the
  // request is under the limit, so deny rather than wave it through.
  if (error) {
    return { allowed: false, retryAfterSeconds: INVITE_WINDOW_SECONDS };
  }

  if ((count ?? 0) >= INVITE_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: INVITE_WINDOW_SECONDS };
  }

  return { allowed: true };
}

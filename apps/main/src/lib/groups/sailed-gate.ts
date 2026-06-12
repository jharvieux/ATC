// §18.10 — Sailed groups are read-only for group details, RSVP, and
// member management. Forum chat stays open separately (per §19.10) and is
// not gated here.
//
// The cron groups-mark-sailed.ts sets status='sailed' + sailed_at on the
// travel_start_date. Routes that mutate group state must call this helper
// to enforce the read-only contract.

import type { SupabaseClient } from "@supabase/supabase-js";

export class GroupSailedError extends Error {
  constructor(public readonly group_id: string, public readonly sailed_at: string | null) {
    super(`Group ${group_id} has sailed; member/RSVP/edit operations are blocked.`);
    this.name = "GroupSailedError";
  }
}

/**
 * Returns silently when the group is not sailed. Throws GroupSailedError
 * when status='sailed'. Throws Error on lookup failure (fail-closed — a
 * group we can't read is a group we can't authorize a mutation against).
 *
 * Caller pattern (route handler):
 *   try { await assertGroupNotSailed(db, groupId, ctx.tenant_id); }
 *   catch (e) {
 *     if (e instanceof GroupSailedError) {
 *       return Response.json({ error: "group_sailed", sailed_at: e.sailed_at }, { status: 410 });
 *     }
 *     throw e;
 *   }
 */
export async function assertGroupNotSailed(
  db: SupabaseClient,
  group_id: string,
  tenant_id: string,
): Promise<void> {
  const { data, error } = await db
    .from("groups")
    .select("status, sailed_at")
    .eq("id", group_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();

  if (error) {
    throw new Error(`group_sailed_lookup_failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`group_sailed_lookup_failed: group ${group_id} not found`);
  }
  const row = data as { status: string; sailed_at: string | null };
  if (row.status === "sailed") {
    throw new GroupSailedError(group_id, row.sailed_at);
  }
}

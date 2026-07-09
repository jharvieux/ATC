// §14.4 follow-up (D-091 R3 #50/#51; hardened #1577) — reconcile bookings stuck
// in 'submitting' state. Runs every 5 minutes via Vercel cron
// (/api/cron/bookings-stuck-submitting-reconcile).
//
// Background: PR #281 introduced a CAS lock `draft → submitting`
// immediately before the host adapter call in /api/bookings/[id]/submit.
// On host-failure the route reverts the lock back to 'draft'. If the
// route process dies between acquiring the lock and either of those
// outcomes, the row stays in 'submitting' indefinitely — every retry
// gets 409 from the CAS lock and the booking never moves forward.
//
// #1577 — this cron MUST NOT revert stuck rows to 'draft'. A row stuck in
// 'submitting' is ambiguous: the process could have died BEFORE the host
// adapter call (no live booking) OR AFTER it succeeded (a real cruise-line
// booking now exists). Reverting to 'draft' lets the agent resubmit and
// double-book at the host. Instead route every stuck row to
// 'pending_host_review' (reason 'host_state_unknown') for manual/adapter
// reconciliation. A status-CAS guards against racing with a still-running
// submit or a completion (submitted / pending_host_review) that landed first.
//
// Bound (STUCK_THRESHOLD_MINUTES = 5) is intentionally short: a normal
// host-adapter submit takes seconds; anything >5min is the route process
// having died or hung.
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

const STUCK_THRESHOLD_MINUTES = 5;

export async function runBookingsStuckSubmittingReconcile(): Promise<{
  flagged: number;
  total_stuck: number;
}> {
  if (process.env.BOOKING_CRONS_DISABLED === "true") {
    return { flagged: 0, total_stuck: 0 };
  }
  const db = createServiceRoleClient();
  const cutoffIso = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data: stuckRows, error } = await db
    .from("bookings")
    .select("id, tenant_id, updated_at")
    .eq("status", "submitting")
    .lt("updated_at", cutoffIso)
    .limit(500);
  if (error) {
    throw new Error(`bookings-stuck-submitting-reconcile: fetch failed: ${error.message}`);
  }

  const stuck = stuckRows ?? [];
  if (stuck.length === 0) return { flagged: 0, total_stuck: 0 };

  // CAS flag: only move the row if it is STILL in 'submitting'. A legitimate
  // completion (status='submitted' or 'pending_host_review') that landed
  // between the select and the update will safely not match.
  let flagged = 0;
  for (const row of stuck as Array<{ id: string; tenant_id: string }>) {
    // safeAwait unwraps { data, error } and throws on truthy error. For
    // a CAS update with .select("id"), the returned value is the
    // affected-row array directly (NOT { data: ... }).
    const updated = (await safeAwait(
      db
        .from("bookings")
        .update({
          status: "pending_host_review",
          review_reason: "host_state_unknown",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "submitting")
        .select("id"),
      "bookings.update.flag_stuck_submitting",
    )) as Array<{ id: string }> | null;
    if (updated && updated.length > 0) {
      flagged++;
      console.info(
        `[bookings-stuck-submitting-reconcile] flagged booking ${row.id} (tenant ${row.tenant_id}) submitting → pending_host_review (host_state_unknown)`,
      );
    }
  }

  return { flagged, total_stuck: stuck.length };
}

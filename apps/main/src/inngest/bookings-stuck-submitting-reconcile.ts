// §14.4 follow-up (D-091 R3 #50/#51) — reconcile bookings stuck in
// 'submitting' state.
//
// Background: PR #281 introduced a CAS lock `draft → submitting`
// immediately before the host adapter call in /api/bookings/[id]/submit.
// On host-failure the route reverts the lock back to 'draft'. If the
// route process dies between acquiring the lock and either of those
// outcomes, the row stays in 'submitting' indefinitely — every retry
// gets 409 from the CAS lock and the booking never moves forward.
//
// This cron runs every 5 minutes. Any booking in 'submitting' for
// more than STUCK_THRESHOLD_MINUTES is reverted to 'draft' so the user
// (or a retry) can submit again. A status-CAS update guards against
// racing with a still-running submit attempt.
//
// Bound (STUCK_THRESHOLD_MINUTES = 5) is intentionally short: a normal
// host-adapter submit takes seconds; anything >5min is the route process
// having died or hung. The submit route's own timeout (defaults to the
// Vercel function ceiling, ~60s for hobby plan) typically lands well
// inside this window.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

const STUCK_THRESHOLD_MINUTES = 5;

export async function runBookingsStuckSubmittingReconcile(): Promise<{
  reverted: number;
  total_stuck: number;
}> {
  if (process.env.BOOKING_CRONS_DISABLED === "true") {
    return { reverted: 0, total_stuck: 0 };
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
  if (stuck.length === 0) return { reverted: 0, total_stuck: 0 };

  // CAS revert: only roll back if the row is STILL in 'submitting'. A
  // legitimate completion (status='submitted' or 'pending_host_review')
  // that landed between the select and the update will safely not match.
  let reverted = 0;
  for (const row of stuck as Array<{ id: string; tenant_id: string }>) {
    // safeAwait unwraps { data, error } and throws on truthy error. For
    // a CAS update with .select("id"), the returned value is the
    // affected-row array directly (NOT { data: ... }).
    const updated = (await safeAwait(
      db
        .from("bookings")
        .update({ status: "draft", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("status", "submitting")
        .select("id"),
      "bookings.update.revert_stuck_submitting",
    )) as Array<{ id: string }> | null;
    if (updated && updated.length > 0) {
      reverted++;
      console.info(
        `[bookings-stuck-submitting-reconcile] reverted booking ${row.id} (tenant ${row.tenant_id}) from submitting → draft`,
      );
    }
  }

  return { reverted, total_stuck: stuck.length };
}

export const bookingsStuckSubmittingReconcile = inngest.createFunction(
  {
    id: "bookings-stuck-submitting-reconcile",
    triggers: [{ cron: "*/5 * * * *" }],
  },
  runBookingsStuckSubmittingReconcile,
);

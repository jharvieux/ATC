// §14.4 — Booking state-machine transitions that must validate at the function
// boundary (D-091 #11). Today the only transition modelled here is the exit
// from `pending_host_review` — the state a booking is parked in when the
// pre-host-call rate resolution fails closed (§14.4). Before #1764 there was NO
// wired way out of it: submit's CAS lock only accepts `draft`, and PATCH forbids
// status changes, so a parked booking required direct DB surgery.
//
// Boundary safety — the crux of why this is a function and not an ad-hoc write:
// ONLY review reasons set BEFORE the host adapter call may return a booking to a
// re-submittable state. Reverting a booking that already reached the host would
// double-book at the cruise line (#1577). The three safe reasons below are all
// set before `adapter.submitBooking()` in the submit route:
//   - commission_rate_unresolvable  (health/adapter config gate, pre-host)
//   - host_adapter_unhealthy         (health gate, pre-host)
//   - missing_platform_split         (tier gate, pre-host)
// The two UNSAFE reasons are refused here because a real/unknown host booking
// may exist:
//   - commission_write_failed  (host call SUCCEEDED, ref persisted, only the
//                               commission write failed — the host booking is real)
//   - host_state_unknown       (reconcile cron flagged a stuck 'submitting' row;
//                               host state is unprovable — #1577)
// The reason gate is enforced INSIDE the CAS predicate, not trusted from the
// caller, so a mis-scoped call site cannot revert an unsafe row.

import "server-only";

import type { tenantClient } from "@/lib/db/tenant-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { writeAuditLog } from "@/lib/audit/write";

// Review reasons for which no live host booking can exist — safe to return to
// 'draft' for the agent to correct trip details and re-run submit.
export const SAFE_TO_RESUBMIT_REVIEW_REASONS = [
  "commission_rate_unresolvable",
  "host_adapter_unhealthy",
  "missing_platform_split",
] as const;

export type ResolvePendingHostReviewResult =
  | { ok: true }
  | {
      ok: false;
      code: "not_found" | "not_in_review" | "host_booking_may_exist";
      status: string | null;
      review_reason: string | null;
    };

// Transition a booking out of `pending_host_review` back to `draft`. The CAS
// matches only rows that are STILL in pending_host_review AND carry a safe
// (pre-host) review reason; a matched row is moved to draft with review_reason
// cleared, and an audit row is written. A 0-row match is explained (informational
// read only — safety already lives in the CAS predicate) so the route can return
// the right status code.
export async function resolvePendingHostReview(opts: {
  db: ReturnType<typeof tenantClient>;
  bookingId: string;
  actorUserId: string;
  tenantId: string;
}): Promise<ResolvePendingHostReviewResult> {
  const { db, bookingId, actorUserId, tenantId } = opts;

  // CAS is by primary-key id (≤1 row); .maybeSingle() bounds it and returns the
  // updated row or null when the guard (status + safe reason) matched nothing.
  const updated = (await safeAwait(
    db
      .from("bookings")
      .update({ status: "draft", review_reason: null, updated_at: new Date().toISOString() })
      .eq("id", bookingId)
      .eq("status", "pending_host_review")
      .in("review_reason", SAFE_TO_RESUBMIT_REVIEW_REASONS as unknown as string[])
      .select("id")
      .maybeSingle(),
    "bookings.update.resolve_pending_host_review",
  )) as { id: string } | null;

  if (updated) {
    await writeAuditLog({
      tenant_id: tenantId,
      actor_type: "user",
      actor_user_id: actorUserId,
      action: "booking.review_resolved",
      resource_type: "booking",
      resource_id: bookingId,
      changes: { from: "pending_host_review", to: "draft" },
    });
    return { ok: true };
  }

  const { data } = await db
    .from("bookings")
    .select("status, review_reason")
    .eq("id", bookingId)
    .maybeSingle();

  if (!data) return { ok: false, code: "not_found", status: null, review_reason: null };
  const row = data as { status: string; review_reason: string | null };
  if (row.status !== "pending_host_review") {
    return { ok: false, code: "not_in_review", status: row.status, review_reason: row.review_reason };
  }
  // In review, but the reason is not in the safe set → a live host booking may
  // exist; refuse the revert (manual reconciliation required).
  return { ok: false, code: "host_booking_may_exist", status: row.status, review_reason: row.review_reason };
}

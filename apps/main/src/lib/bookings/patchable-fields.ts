// §7.6 / §14.4 — Allowed PATCH fields per booking status.
//
// Direct field edits are only safe in draft and pending_host_review (host
// rejected auto-submission; agent fixes trip details and resubmits).
// submitting holds a lock held by the submit flow; submitted / confirmed must
// go through the modify flow so the host adapter stays in sync;
// cancelled / failed are terminal. Internal platform-managed fields (status,
// host_*, ai_paused_by_platform, is_test, id, tenant_id, timestamps) are never
// editable via PATCH.
//
// Shared by api/bookings/[id] PATCH and its unit test so the gating decision
// has one source of truth (D-091 / #384 — no in-test reimplementation).
//
// #1755 — the pending_host_review manual resolution path is INSERT-FREE for
// commissions. A lost race with the reconcile cron can leave a pre-existing
// 'expected' commission on the booking (submit_commit_booking committed it
// while the CAS status-flip lost); commissions_booking_id_uidx (#1575) would
// 23505 any blind re-insert. Resolution here is field edits only (PATCH forbids
// status changes) plus hand reconciliation via the commission update/waive
// paths — no code inserts a commission during resolution. Each insert path —
// the submit_commit_booking RPC (ON CONFLICT (booking_id) DO NOTHING) for
// host-submitted bookings, and promote_import (#1711, migration
// 20260722000006) for imported booking_confirmations — is independently
// idempotent via commissions_booking_id_uidx, and neither is reachable from
// PATCH or pending_host_review resolution. commission-insert-idempotent.test.ts
// pins this so a future resolve route can't reintroduce a blind insert.

export const PATCHABLE_FIELDS_BY_STATUS: Record<string, ReadonlyArray<string>> = {
  draft: [
    "cruise_line",
    "ship_name",
    "sailing_date",
    "duration_nights",
    "cabin_category",
    "departure_port",
    "total_amount_cents",
    "commissionable_fare_cents",
    "currency",
  ],
  pending_host_review: [
    // Same fields as draft — agent fixes + resubmits.
    "cruise_line",
    "ship_name",
    "sailing_date",
    "duration_nights",
    "cabin_category",
    "departure_port",
    "total_amount_cents",
    "commissionable_fare_cents",
    "currency",
  ],
};

// A status with no allowlist entry forbids ALL direct edits (route → 409).
// Checked before per-field gating so an empty / platform-only body still 409s.
export function isStatusPatchable(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(PATCHABLE_FIELDS_BY_STATUS, status);
}

// Whether a specific field may be patched in the given status. False when the
// status is locked OR the field isn't in that status's allowlist (route → 400).
export function isFieldPatchable(status: string, field: string): boolean {
  return (PATCHABLE_FIELDS_BY_STATUS[status] ?? []).includes(field);
}

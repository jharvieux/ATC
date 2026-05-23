// §25.2 — Monthly hard-delete of bookings (and dependent rows) past the
// 7-year retention boundary. Disputes ('open' / 'under_review' on the
// linked commission rows) preserve the booking indefinitely until the
// dispute closes.
//
// Audit-log integration uses console.warn stubs until §26 lands audit_log
// (D-036). The cross-tenant operation pattern would normally wrap each
// tenant in withPlatformAdminAudit; once §26 ships we'll thread that
// through. For now, the per-tenant scope is implicit via the cron's
// service-role scan.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

const SEVEN_YEARS_MS = 7 * 365 * 24 * 60 * 60 * 1000;

export const bookingCommissionRetentionPurge = inngest.createFunction(
  {
    id: "booking-commission-retention-purge",
    triggers: [{ cron: "0 3 1 * *" }], // 1st of each month at 03:00 UTC
  },
  async () => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await svc.from("staging_cron_skips").insert({
        cron_id: "booking-commission-retention-purge",
      });
      return { skipped_for_staging: true };
    }

    const cutoffDate = new Date(Date.now() - SEVEN_YEARS_MS).toISOString().slice(0, 10);

    // Step 1: find booking IDs that are old enough.
    const { data: oldBookings, error: scanErr } = await svc
      .from("bookings")
      .select("id, tenant_id, sailing_date")
      .lt("sailing_date", cutoffDate)
      .limit(2000);
    if (scanErr) {
      console.error("[booking-retention] scan failed:", scanErr.message);
      return { error: scanErr.message };
    }
    const candidateIds = ((oldBookings ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (candidateIds.length === 0) return { deleted_bookings: 0 };

    // Step 2: filter out bookings whose commissions have an open/under_review dispute.
    const { data: disputed } = await svc
      .from("commissions")
      .select("booking_id, dispute_status")
      .in("booking_id", candidateIds)
      .in("dispute_status", ["open", "under_review"]);
    const disputedSet = new Set(
      ((disputed ?? []) as Array<{ booking_id: string }>).map((r) => r.booking_id),
    );
    const deletable = candidateIds.filter((id) => !disputedSet.has(id));
    if (deletable.length === 0) {
      return { deleted_bookings: 0, preserved_for_dispute: disputedSet.size };
    }

    // Step 3: delete dependent rows first, then bookings + commissions.
    //   booking_passengers + booking_options cascade via FK ON DELETE CASCADE.
    //   commissions don't cascade (financial ledger preservation rule) — but
    //   §25.2 says commissions linked to deleted bookings also purge.
    await svc.from("commissions").delete().in("booking_id", deletable);
    const { count, error: delErr } = await svc
      .from("bookings")
      .delete({ count: "exact" })
      .in("id", deletable);
    if (delErr) {
      console.error("[booking-retention] delete failed:", delErr.message);
      return { error: delErr.message };
    }

    console.warn(
      "[audit-log:STUB] " + JSON.stringify({
        action: "retention.bookings_purged",
        deleted_bookings_count: count ?? 0,
        preserved_for_dispute_count: disputedSet.size,
        cutoff_sailing_date: cutoffDate,
        _stub: "audit_log table not yet created",
      }),
    );

    return {
      deleted_bookings: count ?? 0,
      preserved_for_dispute: disputedSet.size,
    };
  },
);

// §14.6 — Daily payout eligibility cron.
//
// Runs daily at 02:00 UTC. Finds payout_records where:
//   status = 'pending' AND hold_release_at <= NOW()
// Transitions them to status = 'available'.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export async function runPayoutsMarkAvailable(): Promise<{ transitioned: number }> {
  if (process.env.BOOKING_CRONS_DISABLED === "true") {
    return { transitioned: 0 };
  }
  const db = createServiceRoleClient();

    const { data: rows, error } = await db
      .from("payout_records")
      .select("id, tenant_id, amount_cents")
      .eq("status", "pending")
      .lte("hold_release_at", new Date().toISOString());

    if (error) {
      throw new Error(`payouts-mark-available: fetch failed: ${error.message}`);
    }

    const pending = rows ?? [];
    if (pending.length === 0) {
      return { transitioned: 0 };
    }

    const ids = pending.map((r) => (r as { id: string }).id);
    // D-091 R3 Pattern 7 — CAS guard via .eq("status", "pending"). Without
    // it, a row transitioned out of 'pending' (e.g., manually cancelled or
    // moved to 'failed' by an operator) between the select above and this
    // update would still be flipped to 'available', creating a phantom
    // payout. Chaining .select("id") gives us the affected-row count so
    // we can detect partial transitions and log them.
    const { data: transitionedRows, error: updateError } = await db
      .from("payout_records")
      .update({ status: "available" })
      .in("id", ids)
      .eq("status", "pending")
      .select("id");

    if (updateError) {
      throw new Error(`payouts-mark-available: update failed: ${updateError.message}`);
    }

    const transitioned = (transitionedRows as Array<{ id: string }> | null)?.length ?? 0;
    if (transitioned !== ids.length) {
      console.warn(
        `payouts-mark-available: CAS mismatch — selected ${ids.length} 'pending' rows but only ${transitioned} transitioned (others raced to a non-pending status before update)`,
      );
    } else {
      console.info(`payouts-mark-available: transitioned ${transitioned} records to 'available'`);
    }
    return { transitioned };
}

export const payoutsMarkAvailable = inngest.createFunction(
  {
    id: "payouts-mark-available",
    triggers: [{ cron: "0 2 * * *" }],
  },
  runPayoutsMarkAvailable,
);

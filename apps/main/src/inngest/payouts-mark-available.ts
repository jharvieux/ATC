// §14.6 — Daily payout eligibility cron.
//
// Runs daily at 02:00 UTC. Finds payout_records where:
//   status = 'pending' AND hold_release_at <= NOW()
// Transitions them to status = 'available'.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const payoutsMarkAvailable = inngest.createFunction(
  {
    id: "payouts-mark-available",
    triggers: [{ cron: "0 2 * * *" }],
  },
  async () => {
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
    const { error: updateError } = await db
      .from("payout_records")
      .update({ status: "available" })
      .in("id", ids);

    if (updateError) {
      throw new Error(`payouts-mark-available: update failed: ${updateError.message}`);
    }

    console.info(`payouts-mark-available: transitioned ${ids.length} records to 'available'`);
    return { transitioned: ids.length };
  },
);

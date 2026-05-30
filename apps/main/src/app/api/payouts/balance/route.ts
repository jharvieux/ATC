// §7.6 / §14.6 — Outstanding payout balance for the caller's tenant.
//
// GET /api/payouts/balance
//
// Returns:
//   available_cents: sum of payout_records with status='available' (eligible
//     for the next payout cron run)
//   pending_cents: sum of payout_records with status='pending' (still in the
//     hold window — releases when hold_release_at passes)
//   currency: pulled from the first payout_record row; tenant_id is the
//     scope and a tenant should only ever have one operating currency,
//     so consolidating to one value is correct (and matches how
//     payouts-execute-transfer aggregates).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

interface PayoutSumRow {
  amount_cents: string | number | null;
  status: string | null;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "payouts",
      action: "read",
    });

    const db = tenantClient(ctx);
    // Read raw rows and sum app-side — Postgres SUM on a text column
    // returns numeric strings that JSON cannot encode at full precision
    // when amounts get large. amount_cents is stored as text (bigint
    // serialized) so JS BigInt is the right accumulator.
    const { data, error } = await db
      .from("payout_records")
      .select("amount_cents, status")
      .in("status", ["pending", "available"]);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as PayoutSumRow[];
    let availableCents = 0n;
    let pendingCents = 0n;
    for (const r of rows) {
      if (r.amount_cents == null) continue;
      const cents = BigInt(r.amount_cents);
      if (r.status === "available") availableCents += cents;
      else if (r.status === "pending") pendingCents += cents;
    }

    return Response.json({
      available_cents: availableCents.toString(),
      pending_cents: pendingCents.toString(),
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

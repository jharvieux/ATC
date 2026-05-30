// §7.6 / §14.6 — Outstanding payout balance for the caller's tenant.
//
// amount_cents is stored as text (bigint serialized) so JS BigInt is the
// right accumulator — JSON.stringify on summed floats would silently lose
// precision once balances cross ~9 quadrillion cents and drift well below
// that on imprecise float arithmetic.

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
    const { data, error } = await db
      .from("payout_records")
      .select("amount_cents, status")
      .in("status", ["pending", "available"]);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    // Read raw rows and sum app-side; see file header.
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

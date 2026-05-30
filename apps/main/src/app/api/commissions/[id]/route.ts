// §7.6 / §14 — Get one commission row.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

const COLUMNS =
  "id, tenant_id, booking_id, status, commissionable_fare_cents, " +
  "gross_commission_cents, net_commission_cents, " +
  "subhost_payable_cents, platform_retained_cents, " +
  "commission_rate, platform_split_rate, currency, " +
  "host_booking_fee_cents, host_booking_fee_rule_ref, " +
  "created_at, updated_at";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "commissions",
      action: "read",
    });

    const { id } = await params;
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("commissions")
      .select(COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      // Either doesn't exist or RLS hid a cross-tenant row — same shape
      // either way; don't leak existence.
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return Response.json({ commission: data });
  } catch (err) {
    return respondToAuthError(err);
  }
}

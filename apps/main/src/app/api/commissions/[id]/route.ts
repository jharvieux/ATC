// §7.6 / §14 — Single commission detail. 404 same shape whether missing
// or RLS-hidden so cross-tenant existence isn't leaked.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { COMMISSIONS_READ_COLUMNS } from "@/lib/commissions/columns";
import { dbErrorResponse } from "@/lib/api/db-error-response";

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
      .select(COMMISSIONS_READ_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) {
      return dbErrorResponse(error);
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

// §7.6 / §14 — List commissions visible to the caller's tenant.
//
// GET /api/commissions?status=&limit=&offset=
//
// RLS on `commissions` scopes by tenant_id. Status filter is optional;
// supported values mirror the commission state machine: expected,
// received, paid, clawed_back.

import { z } from "zod";
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

const QuerySchema = z.object({
  status: z.enum(["expected", "received", "paid", "clawed_back"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "commissions",
      action: "read",
    });

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });
    if (!parsed.success) {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    const { status, limit, offset } = parsed.data;

    const db = tenantClient(ctx);
    let q = db
      .from("commissions")
      .select(COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) q = q.eq("status", status);

    const { data, error, count } = await q;
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({
      commissions: data ?? [],
      total: count ?? null,
      limit,
      offset,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

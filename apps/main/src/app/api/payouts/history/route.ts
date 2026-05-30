// §7.6 / §14.6 — Past payouts for the caller's tenant.
//
// GET /api/payouts/history?status=&limit=&offset=
//
// Defaults to status=paid (the most useful default — "show me what
// landed"); other statuses are explicit. Pagination matches the
// commissions list.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

const COLUMNS =
  "id, tenant_id, amount_cents, status, hold_release_at, commission_id, " +
  "payout_intent, created_at, updated_at";

const QuerySchema = z.object({
  status: z
    .enum(["pending", "available", "paid", "failed", "in_flight"])
    .default("paid"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "payouts",
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
    const { data, error, count } = await db
      .from("payout_records")
      .select(COLUMNS, { count: "exact" })
      .eq("status", status)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({
      payouts: data ?? [],
      total: count ?? null,
      limit,
      offset,
      status,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

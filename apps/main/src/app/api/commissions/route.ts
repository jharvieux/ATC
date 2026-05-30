// §7.6 / §14 — Tenant-scoped commissions list. Status filter mirrors the
// commission state machine; limit is capped at 100 to prevent accidental
// full-table scans.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { COMMISSIONS_READ_COLUMNS } from "@/lib/commissions/columns";

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
      .select(COMMISSIONS_READ_COLUMNS, { count: "exact" })
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

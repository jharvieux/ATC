// BP40 §40.5.3 — "Components" bulk view across all bookings.
//
// Filters: item_type, status, supplier_name (ilike), date range on start_date.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

const VALID_TYPES = new Set(["flight", "hotel", "transfer", "excursion", "insurance", "other"]);
const VALID_STATUSES = new Set(["planned", "booked", "confirmed", "cancelled", "completed"]);

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings.line_items", action: "list" });
    const db = tenantClient(ctx);
    const url = new URL(req.url);
    const itemType = url.searchParams.get("item_type");
    const status = url.searchParams.get("status");
    const supplier = url.searchParams.get("supplier_name");
    const startFrom = url.searchParams.get("start_from");
    const startTo = url.searchParams.get("start_to");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

    if (itemType && !VALID_TYPES.has(itemType)) {
      return Response.json({ error: `invalid item_type: ${itemType}` }, { status: 400 });
    }
    if (status && !VALID_STATUSES.has(status)) {
      return Response.json({ error: `invalid status: ${status}` }, { status: 400 });
    }

    let q = db
      .from("booking_line_items")
      .select("*", { count: "exact" })
      .order("start_date", { ascending: true, nullsFirst: false })
      .limit(limit);
    if (itemType) q = q.eq("item_type", itemType);
    if (status) q = q.eq("status", status);
    if (supplier) q = q.ilike("supplier_name", `%${supplier}%`);
    if (startFrom) q = q.gte("start_date", startFrom);
    if (startTo) q = q.lte("start_date", startTo);

    const { data, count, error } = await q;
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json({ items: data ?? [], total: count ?? 0 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

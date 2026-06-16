// #783 — Cruise ship catalog read for cascading group-booking dropdowns.
//
// GET /api/cruise-ships?cruise_line_id=<uuid>
//   Returns active ships for the selected cruise line.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "groups", action: "create" });
    const db = tenantClient(ctx);

    const { searchParams } = new URL(req.url);
    const cruiseLineId = searchParams.get("cruise_line_id");
    if (!cruiseLineId) {
      return Response.json({ error: "cruise_line_id is required" }, { status: 400 });
    }

    const { data, error } = await db
      .from("cruise_ships")
      .select("id, canonical_name, ship_class")
      .eq("cruise_line_id", cruiseLineId)
      .eq("is_active", true)
      .order("canonical_name", { ascending: true });

    if (error) return dbErrorResponse(error);
    return Response.json({ ships: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

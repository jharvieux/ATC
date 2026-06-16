// #783 — Sailing catalog read for cascading group-booking dropdowns.
//
// GET /api/cruise-sailings?cruise_ship_id=<uuid>
//   Returns upcoming sailings for a ship with port calls, ordered by departure_date.
//   Filters to departure_date >= today so stale sailings don't appear in the dropdown.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "groups", action: "create" });
    const db = tenantClient(ctx);

    const { searchParams } = new URL(req.url);
    const cruiseShipId = searchParams.get("cruise_ship_id");
    if (!cruiseShipId) {
      return Response.json({ error: "cruise_ship_id is required" }, { status: 400 });
    }

    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await db
      .from("cruise_sailings")
      .select("id, departure_date, departure_port, duration_nights, region, starting_price, sailing_port_calls(port_name, day_index)")
      .eq("cruise_ship_id", cruiseShipId)
      .gte("departure_date", today)
      .order("departure_date", { ascending: true });

    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    const sailings = (data ?? []).map((s) => ({
      id: s.id,
      departure_date: s.departure_date,
      departure_port: s.departure_port,
      duration_nights: s.duration_nights,
      region: s.region,
      starting_price: s.starting_price,
      ports: (s.sailing_port_calls ?? [])
        .sort((a, b) => a.day_index - b.day_index)
        .map((pc) => pc.port_name),
    }));

    return Response.json({ sailings });
  } catch (err) {
    return respondToAuthError(err);
  }
}

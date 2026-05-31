// #487 — GET /api/itinerary
//
// Read-only lookup for pre-cruise email enrichment (destination images +
// multi-day forecast). Returns ports_of_call + day_by_day for a sailing
// identified by (cruise_line, ship, departure_date). Any service-role JWT
// with scope "read" is accepted — no platform-admin restriction.

export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

export const GET = withServiceAuth(async (req, ctx) => {
  if (ctx.scope !== "read" && ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const cruise_line = searchParams.get("cruise_line");
  const ship = searchParams.get("ship");
  const departure_date = searchParams.get("departure_date");

  if (!cruise_line || !ship || !departure_date) {
    return Response.json({ error: "missing_params: cruise_line, ship, departure_date required" }, { status: 400 });
  }

  const db = getRagDb();
  const { data, error } = await db
    .from("itineraries")
    .select("ports_of_call, day_by_day, region")
    .eq("cruise_line", cruise_line)
    .eq("ship", ship)
    .eq("departure_date", departure_date)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[itinerary/get] db error:", error);
    return Response.json({ error: "db_error" }, { status: 500 });
  }

  return Response.json(data ?? null);
});

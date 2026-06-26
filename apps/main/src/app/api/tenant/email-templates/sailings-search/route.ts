// Sailing search for the email template preview sailing picker.
//
// GET /api/tenant/email-templates/sailings-search?q=<text>&limit=<n>
//
// Searches cruise_ships by canonical_name (ilike), then returns upcoming
// sailings for matching ships. Results carry ship_name + cruise_line_name so
// the UI can populate template variables without a second lookup.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const MAX_LIMIT = 20;

interface ShipRow {
  id: string;
  canonical_name: string;
  cruise_lines: { display_name: string } | null;
}

interface SailingRow {
  id: string;
  departure_date: string;
  departure_port: string;
  duration_nights: number;
  cruise_ship_id: string;
}

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "email_templates", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { ctx } = auth;
  const db = tenantClient(ctx);

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, MAX_LIMIT);

  const today = new Date().toISOString().slice(0, 10);

  if (!q) {
    return Response.json({ sailings: [] });
  }

  // Step 1: find ships whose canonical name matches the query.
  // cruise_ships is accessible to authenticated users via its RLS policy.
  const { data: ships, error: shipErr } = await db
    .from("cruise_ships")
    .select("id, canonical_name, cruise_lines(display_name)")
    .ilike("canonical_name", `%${q}%`)
    .eq("is_active", true)
    .limit(10);

  if (shipErr) return dbErrorResponse(shipErr);
  const typedShips = (ships ?? []) as unknown as ShipRow[];
  if (typedShips.length === 0) return Response.json({ sailings: [] });

  const shipIds = typedShips.map((s) => s.id);
  const shipMap = new Map(typedShips.map((s) => [s.id, s]));

  // Step 2: upcoming sailings for those ships.
  const { data: sailings, error: sailErr } = await db
    .from("cruise_sailings")
    .select("id, departure_date, departure_port, duration_nights, cruise_ship_id")
    .in("cruise_ship_id", shipIds)
    .gte("departure_date", today)
    .order("departure_date", { ascending: true })
    .limit(limit);

  if (sailErr) return dbErrorResponse(sailErr);

  const result = ((sailings ?? []) as unknown as SailingRow[]).map((s) => {
    const ship = shipMap.get(s.cruise_ship_id);
    return {
      id: s.id,
      departure_date: s.departure_date,
      departure_port: s.departure_port,
      duration_nights: s.duration_nights,
      ship_name: ship?.canonical_name ?? "",
      cruise_line_name: ship?.cruise_lines?.display_name ?? "",
    };
  });

  return Response.json({ sailings: result });
}

// #783 — Cruise line catalog read for cascading group-booking dropdowns.
//
// GET /api/cruise-lines
//   Returns active cruise lines for the line-selector dropdown.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "groups", action: "create" });
    const db = tenantClient(ctx);

    const { data, error } = await db
      .from("cruise_lines")
      .select("id, display_name")
      .eq("is_active", true)
      .order("display_name", { ascending: true });

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ lines: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

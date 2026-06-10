// #780 — GET /api/admin/cruise-catalog/ships
// List ships, optionally filtered by ?line_id=<uuid>.
// Ships are discovered by the scraper — no POST here.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdmin, PlatformAdminError, type PlatformAdminContext } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";

const SHIP_COLS = "id, cruise_line_id, slug, canonical_name, ship_class, is_active, cruisemapper_slug, created_at";

export async function GET(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformAdmin(req);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const lineId = searchParams.get("line_id");

  try {
    const ships = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "cruise_catalog_read", operation: "cruise_ships.list" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "cruise_ships" });
        let q = db.from("cruise_ships").select(SHIP_COLS).order("canonical_name");
        if (lineId) q = q.eq("cruise_line_id", lineId);
        return await safeAwait<unknown[]>(q, "cruise_ships.list") ?? [];
      },
    );
    return Response.json({ ships });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

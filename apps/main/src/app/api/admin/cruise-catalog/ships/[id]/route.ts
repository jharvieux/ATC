// #780 — PATCH /api/admin/cruise-catalog/ships/[id]
// Toggle is_active; optionally update ship_class.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError, type PlatformAdminContext } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const SHIP_COLS = "id, cruise_line_id, slug, canonical_name, ship_class, is_active, cruisemapper_slug, created_at";

interface PatchShipBody {
  is_active?: boolean;
  ship_class?: string | null;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformAdminArea(req, "cruise_catalog");
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: PatchShipBody;
  try {
    body = (await req.json()) as PatchShipBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.is_active !== undefined) update.is_active = body.is_active;
  if ("ship_class" in body) update.ship_class = body.ship_class ?? null;

  if (Object.keys(update).length === 1) {
    return Response.json({ error: "no_fields_to_update" }, { status: 400 });
  }

  try {
    const ship = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "cruise_catalog_update_ship", operation: "cruise_ships.update" },
      async (db, recordQuery) => {
        recordQuery({ op: "update", table: "cruise_ships" });
        const rows = await safeAwait<unknown[]>(
          db.from("cruise_ships").update(update).eq("id", id).select(SHIP_COLS),
          "cruise_ships.update",
        );
        return rows?.[0] ?? null;
      },
    );
    if (!ship) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ ship });
  } catch (err) {
    return dbErrorResponse(err);
  }
}

// #780 — PATCH /api/admin/cruise-catalog/ships/[id]
// Toggle is_active; optionally update ship_class.
// #1565 — also edit the RAG-populated stat fields (guest_capacity, decks,
// built_year, signature_feature) that have no automated curation path.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError, type PlatformAdminContext } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const SHIP_COLS =
  "id, cruise_line_id, slug, canonical_name, ship_class, is_active, cruisemapper_slug, guest_capacity, decks, built_year, signature_feature, created_at";

const SIGNATURE_FEATURE_MAX = 120;

interface PatchShipBody {
  is_active?: boolean;
  ship_class?: string | null;
  guest_capacity?: number | null;
  decks?: number | null;
  built_year?: number | null;
  signature_feature?: string | null;
}

// A stat integer must be a positive whole number, or null to clear it.
// `min`/`max` bound obviously-wrong values (a 3-digit year, a 6-figure deck
// count) before they reach the DB. Returns "invalid" for anything else so the
// route can 400 rather than silently coerce.
function parseStatInt(v: unknown, min: number, max: number): number | null | "invalid" {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return "invalid";
  return v;
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

  if ("guest_capacity" in body) {
    const v = parseStatInt(body.guest_capacity, 1, 100_000);
    if (v === "invalid") return Response.json({ error: "invalid_guest_capacity" }, { status: 400 });
    update.guest_capacity = v;
  }
  if ("decks" in body) {
    const v = parseStatInt(body.decks, 1, 100);
    if (v === "invalid") return Response.json({ error: "invalid_decks" }, { status: 400 });
    update.decks = v;
  }
  if ("built_year" in body) {
    const v = parseStatInt(body.built_year, 1900, new Date().getFullYear() + 5);
    if (v === "invalid") return Response.json({ error: "invalid_built_year" }, { status: 400 });
    update.built_year = v;
  }
  if ("signature_feature" in body) {
    if (body.signature_feature === null) {
      update.signature_feature = null;
    } else if (typeof body.signature_feature !== "string") {
      return Response.json({ error: "invalid_signature_feature" }, { status: 400 });
    } else {
      const trimmed = body.signature_feature.trim();
      if (trimmed.length > SIGNATURE_FEATURE_MAX) {
        return Response.json({ error: "invalid_signature_feature" }, { status: 400 });
      }
      update.signature_feature = trimmed === "" ? null : trimmed;
    }
  }

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

// #780 — PATCH /api/admin/cruise-catalog/ports/[id]
// Toggle is_active; optionally update country/region/canonical_name.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformRole, PlatformAdminError, type PlatformAdminContext } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";

const PORT_COLS = "id, slug, canonical_name, country, region, is_active, cruisemapper_slug, created_at";

interface PatchPortBody {
  is_active?: boolean;
  canonical_name?: string;
  country?: string | null;
  region?: string | null;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: PatchPortBody;
  try {
    body = (await req.json()) as PatchPortBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.is_active !== undefined) update.is_active = body.is_active;
  if (body.canonical_name !== undefined) update.canonical_name = body.canonical_name;
  if ("country" in body) update.country = body.country ?? null;
  if ("region" in body) update.region = body.region ?? null;

  if (Object.keys(update).length === 1) {
    return Response.json({ error: "no_fields_to_update" }, { status: 400 });
  }

  try {
    const port = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "cruise_catalog_update_port", operation: "ports.update" },
      async (db, recordQuery) => {
        recordQuery({ op: "update", table: "ports" });
        const rows = await safeAwait<unknown[]>(
          db.from("ports").update(update).eq("id", id).select(PORT_COLS),
          "ports.update",
        );
        return rows?.[0] ?? null;
      },
    );
    if (!port) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ port });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

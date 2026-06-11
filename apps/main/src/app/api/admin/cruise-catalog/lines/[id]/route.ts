// #780 — PATCH /api/admin/cruise-catalog/lines/[id]
// Toggle is_active, update tier/website_url/display_name/canonical_name.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformRole, PlatformAdminError, type PlatformAdminContext } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";

const LINE_COLS = "id, slug, canonical_name, display_name, tier, is_active, cruisemapper_slug, website_url, created_at";

interface PatchLineBody {
  is_active?: boolean;
  tier?: string;
  display_name?: string;
  canonical_name?: string;
  website_url?: string | null;
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

  let body: PatchLineBody;
  try {
    body = (await req.json()) as PatchLineBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.tier !== undefined && !["mainstream", "premium", "luxury"].includes(body.tier)) {
    return Response.json({ error: "invalid_tier" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.is_active !== undefined) update.is_active = body.is_active;
  if (body.tier !== undefined) update.tier = body.tier;
  if (body.display_name !== undefined) update.display_name = body.display_name;
  if (body.canonical_name !== undefined) update.canonical_name = body.canonical_name;
  if ("website_url" in body) update.website_url = body.website_url ?? null;

  if (Object.keys(update).length === 1) {
    return Response.json({ error: "no_fields_to_update" }, { status: 400 });
  }

  try {
    const line = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "cruise_catalog_update_line", operation: "cruise_lines.update" },
      async (db, recordQuery) => {
        recordQuery({ op: "update", table: "cruise_lines" });
        const rows = await safeAwait<unknown[]>(
          db.from("cruise_lines").update(update).eq("id", id).select(LINE_COLS),
          "cruise_lines.update",
        );
        return rows?.[0] ?? null;
      },
    );
    if (!line) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ line });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

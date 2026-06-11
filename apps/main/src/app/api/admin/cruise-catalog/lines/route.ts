// #780 — Platform-admin cruise line catalog.
//
// GET  /api/admin/cruise-catalog/lines  → { lines }
// POST /api/admin/cruise-catalog/lines  → { line } (create)

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformRole, PlatformAdminError, type PlatformAdminContext } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";

const LINE_COLS = "id, slug, canonical_name, display_name, tier, is_active, cruisemapper_slug, website_url, created_at";

export async function GET(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const lines = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "cruise_catalog_read", operation: "cruise_lines.list" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "cruise_lines" });
        return await safeAwait<unknown[]>(
          db.from("cruise_lines").select(LINE_COLS).order("tier").order("display_name"),
          "cruise_lines.list",
        ) ?? [];
      },
    );
    return Response.json({ lines });
  } catch (err) { return Response.json({ error: String(err) }, { status: 500 }); }
}

interface CreateLineBody {
  slug: string;
  canonical_name: string;
  display_name: string;
  tier: string;
  cruisemapper_slug: string;
  website_url?: string;
}

export async function POST(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: CreateLineBody;
  try {
    body = (await req.json()) as CreateLineBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.slug || !body.canonical_name || !body.display_name || !body.tier || !body.cruisemapper_slug) {
    return Response.json({ error: "missing_required_fields" }, { status: 400 });
  }
  if (!["mainstream", "premium", "luxury"].includes(body.tier)) {
    return Response.json({ error: "invalid_tier" }, { status: 400 });
  }

  try {
    const line = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "cruise_catalog_add_line", operation: "cruise_lines.insert" },
      async (db, recordQuery) => {
        recordQuery({ op: "insert", table: "cruise_lines" });
        const rows = await safeAwait<unknown[]>(
          db.from("cruise_lines")
            .insert({
              slug: body.slug,
              canonical_name: body.canonical_name,
              display_name: body.display_name,
              tier: body.tier,
              cruisemapper_slug: body.cruisemapper_slug,
              website_url: body.website_url ?? null,
            })
            .select(LINE_COLS),
          "cruise_lines.insert",
        );
        return rows?.[0];
      },
    );
    return Response.json({ line }, { status: 201 });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return Response.json({ error: "duplicate_slug_or_cruisemapper_slug" }, { status: 409 });
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}

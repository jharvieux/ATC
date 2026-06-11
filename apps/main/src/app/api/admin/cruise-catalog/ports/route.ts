// #780 — Cruise catalog ports API.
//
// GET  /api/admin/cruise-catalog/ports → { ports }
// POST /api/admin/cruise-catalog/ports → { port } (create)

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformRole, PlatformAdminError, type PlatformAdminContext } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";

const PORT_COLS = "id, slug, canonical_name, country, region, is_active, cruisemapper_slug, created_at";

export async function GET(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const ports = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "cruise_catalog_read", operation: "ports.list" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "ports" });
        return await safeAwait<unknown[]>(
          db.from("ports").select(PORT_COLS).order("canonical_name"),
          "ports.list",
        ) ?? [];
      },
    );
    return Response.json({ ports });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

interface CreatePortBody {
  slug: string;
  canonical_name: string;
  country?: string;
  region?: string;
  cruisemapper_slug?: string;
}

export async function POST(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: CreatePortBody;
  try {
    body = (await req.json()) as CreatePortBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.slug || !body.canonical_name) {
    return Response.json({ error: "missing_required_fields" }, { status: 400 });
  }

  try {
    const port = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "cruise_catalog_add_port", operation: "ports.insert" },
      async (db, recordQuery) => {
        recordQuery({ op: "insert", table: "ports" });
        const rows = await safeAwait<unknown[]>(
          db.from("ports")
            .insert({
              slug: body.slug,
              canonical_name: body.canonical_name,
              country: body.country ?? null,
              region: body.region ?? null,
              cruisemapper_slug: body.cruisemapper_slug ?? null,
            })
            .select(PORT_COLS),
          "ports.insert",
        );
        return rows?.[0];
      },
    );
    return Response.json({ port }, { status: 201 });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return Response.json({ error: "duplicate_slug_or_cruisemapper_slug" }, { status: 409 });
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}

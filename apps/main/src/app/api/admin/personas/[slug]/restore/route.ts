// D-138 §9.3 — Restore a persona to its code-default (full reset).
//
// POST /api/admin/personas/[slug]/restore
//   → { ok: true, slug, version, restored: true }
//      404 unknown_persona_slug if there is no code default for the slug
//      404 persona_not_found     if the slug has a default but no DB row
//
// Restore writes the FULL editable-field payload from PERSONA_DEFAULTS via the
// same version-CAS path as PUT, so it is auditable and cache-invalidating.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import {
  assertPlatformAdminArea,
  PlatformAdminError,
  type PlatformAdminContext,
} from "@/lib/auth/assert-platform-admin";
import { applyPersonaPatch, personaDefaultPatch } from "@/lib/personas/persona-admin";
import { getPersonaDefault } from "@/lib/personas/persona-defaults";
import { clearPersonaRepositoryCaches } from "@/lib/personas/persona-repository";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformAdminArea(req, "personas");
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const { slug } = await params;

  const def = getPersonaDefault(slug);
  if (!def) return Response.json({ error: "unknown_persona_slug" }, { status: 404 });

  const updatedBy = ctx.via === "session" ? ctx.admin_user_id : null;

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "persona_config_restore", operation: "personas.restore" },
      async (db, recordQuery) => {
        recordQuery({ op: "update", table: "personas" });
        return applyPersonaPatch(db, slug, personaDefaultPatch(def), updatedBy);
      },
    );
    if ("notFound" in result) return Response.json({ error: "persona_not_found" }, { status: 404 });
    clearPersonaRepositoryCaches();
    return Response.json({ ok: true, slug, version: result.version, restored: true });
  } catch (err) {
    return dbErrorResponse(err);
  }
}

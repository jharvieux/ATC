// D-138 §9.3 — Platform-admin persona detail + edit.
//
// GET /api/admin/personas/[slug]
//   → { persona: { slug, kind, version, ...editable fields } }  (404 if no row)
//
// PUT /api/admin/personas/[slug]
//   Body: any SUBSET of the editable columns (≥1). Version-CAS write.
//   → { ok: true, slug, version }  (404 if no row, 422 on validation failure)
//
// Personas are global config (no tenant_id); only platform admins read/write
// them here. All access is audited via withPlatformAdminAudit. A successful
// write clears the hot-path repository cache so the next chat turn rebuilds.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import {
  assertPlatformAdmin,
  PlatformAdminError,
  type PlatformAdminContext,
} from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";
import {
  PERSONA_DETAIL_COLUMNS,
  validatePersonaPatch,
  applyPersonaPatch,
} from "@/lib/personas/persona-admin";
import { clearPersonaRepositoryCaches } from "@/lib/personas/persona-repository";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformAdmin(req);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const { slug } = await params;

  try {
    const persona = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "persona_config_read", operation: "personas.detail" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "personas" });
        return safeAwait<Record<string, unknown>>(
          db.from("personas").select(PERSONA_DETAIL_COLUMNS).eq("slug", slug).maybeSingle(),
          "personas.detail",
        );
      },
    );
    if (!persona) return Response.json({ error: "persona_not_found" }, { status: 404 });
    return Response.json({ persona });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformAdmin(req);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }
  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const validation = validatePersonaPatch(body);
  if (!validation.ok) {
    return Response.json({ error: validation.error, field: validation.field }, { status: 422 });
  }

  // updated_by is a UUID column. Only the session path resolves to a real
  // admin UUID; the service-to-service bearer path uses a sentinel, so null it.
  const updatedBy = ctx.via === "session" ? ctx.admin_user_id : null;

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "persona_config_update", operation: "personas.update" },
      async (db, recordQuery) => {
        recordQuery({ op: "update", table: "personas" });
        return applyPersonaPatch(db, slug, validation.patch, updatedBy);
      },
    );
    if ("notFound" in result) return Response.json({ error: "persona_not_found" }, { status: 404 });
    clearPersonaRepositoryCaches();
    return Response.json({ ok: true, slug, version: result.version });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

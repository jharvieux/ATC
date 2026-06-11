// D-138 §9.3 — Platform-admin editable safety block (Layer 2).
//
// GET /api/admin/persona-safety
//   → { legal_kernel, editable_block, version, default_editable_block }
//      legal_kernel is the code-enforced, READ-ONLY floor (shown so the admin
//      knows what is always applied); editable_block is the admin-owned section.
//
// PUT /api/admin/persona-safety
//   Body: { editable_block: string }   (non-empty)
//   → { ok: true, version }            (422 if blank/non-string)
//
// The safety block is a singleton (persona_safety_config id='default'), seeded
// by migration. Writes are version-CAS and clear the hot-path cache.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import {
  assertPlatformRole,
  PlatformAdminError,
  type PlatformAdminContext,
} from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";
import { applySafetyPatch } from "@/lib/personas/persona-admin";
import { LEGAL_KERNEL, SAFETY_EDITABLE_DEFAULT } from "@/lib/personas/platform-constraints";
import { clearPersonaRepositoryCaches } from "@/lib/personas/persona-repository";

export async function GET(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "persona_config_read", operation: "persona_safety.get" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "persona_safety_config" });
        const row = await safeAwait<{ editable_block: string; version: number }>(
          db.from("persona_safety_config").select("editable_block, version").eq("id", "default").maybeSingle(),
          "persona_safety_config.get",
        );
        return {
          legal_kernel: LEGAL_KERNEL,
          editable_block: row?.editable_block ?? SAFETY_EDITABLE_DEFAULT,
          version: row?.version ?? 0,
          default_editable_block: SAFETY_EDITABLE_DEFAULT,
        };
      },
    );
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: { editable_block?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const editableBlock = body.editable_block;
  if (typeof editableBlock !== "string" || editableBlock.trim().length === 0) {
    return Response.json({ error: "editable_block must be a non-empty string" }, { status: 422 });
  }

  const updatedBy = ctx.via === "session" ? ctx.admin_user_id : null;

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "persona_safety_update", operation: "persona_safety.update" },
      async (db, recordQuery) => {
        recordQuery({ op: "update", table: "persona_safety_config" });
        return applySafetyPatch(db, editableBlock, updatedBy);
      },
    );
    clearPersonaRepositoryCaches();
    return Response.json({ ok: true, version: result.version });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

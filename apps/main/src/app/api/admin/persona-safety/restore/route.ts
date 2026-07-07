// D-138 §9.3 — Restore the editable safety block to its code default.
//
// POST /api/admin/persona-safety/restore
//   → { ok: true, version, restored: true }
//
// Writes SAFETY_EDITABLE_DEFAULT back into persona_safety_config via the same
// version-CAS path as PUT. The legal kernel is never touched (code-side).

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import {
  assertPlatformAdminArea,
  PlatformAdminError,
  type PlatformAdminContext,
} from "@/lib/auth/assert-platform-admin";
import { applySafetyPatch } from "@/lib/personas/persona-admin";
import { SAFETY_EDITABLE_DEFAULT } from "@/lib/personas/platform-constraints";
import { clearPersonaRepositoryCaches } from "@/lib/personas/persona-repository";

export async function POST(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformAdminArea(req, "persona_safety");
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const updatedBy = ctx.via === "session" ? ctx.admin_user_id : null;

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "persona_safety_restore", operation: "persona_safety.restore" },
      async (db, recordQuery) => {
        recordQuery({ op: "update", table: "persona_safety_config" });
        return applySafetyPatch(db, SAFETY_EDITABLE_DEFAULT, updatedBy);
      },
    );
    clearPersonaRepositoryCaches();
    return Response.json({ ok: true, version: result.version, restored: true });
  } catch (err) {
    return dbErrorResponse(err);
  }
}

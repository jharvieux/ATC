// D-138 §9.3 — Platform-admin persona list.
//
// GET /api/admin/personas
//   → { personas: [{ slug, kind, display_name, tagline, specialty,
//                     is_active, sort_order, version }] }  (sort_order ASC)
//
// Personas are global config (no tenant_id); only platform admins read/write
// them here. All access is audited via withPlatformAdminAudit.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import {
  assertPlatformAdminArea,
  PlatformAdminError,
  type PlatformAdminContext,
} from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";
import { PERSONA_LIST_COLUMNS } from "@/lib/personas/persona-admin";

export async function GET(req: Request): Promise<Response> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await assertPlatformAdminArea(req, "personas");
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const personas = await withPlatformAdminAudit(
      { admin_user_id: ctx.admin_user_id, reason: "persona_config_read", operation: "personas.list" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "personas" });
        const rows = await safeAwait<Array<Record<string, unknown>>>(
          db.from("personas").select(PERSONA_LIST_COLUMNS).order("sort_order", { ascending: true }),
          "personas.list",
        );
        return rows ?? [];
      },
    );
    return Response.json({ personas });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

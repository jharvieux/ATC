/** Spec ref: §7.8 — Update knowledge chunk */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function PATCH(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Update knowledge chunk", action: "patch" });
    void ctx;
    return Response.json({ todo: "Update knowledge chunk", spec_section: "§7.8" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

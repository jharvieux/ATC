/** Spec ref: §7.4 — Update contact */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function PATCH(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Update contact", action: "patch" });
    void ctx;
    return Response.json({ todo: "Update contact", spec_section: "§7.4" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

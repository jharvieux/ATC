/** Spec ref: §7.4 — Get contact timeline */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Get contact timeline", action: "get" });
    void ctx;
    return Response.json({ todo: "Get contact timeline", spec_section: "§7.4" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

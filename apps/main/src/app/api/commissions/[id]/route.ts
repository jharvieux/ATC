/** Spec ref: §7.6 — Get commission */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Get commission", action: "get" });
    void ctx;
    return Response.json({ todo: "Get commission", spec_section: "§7.6" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

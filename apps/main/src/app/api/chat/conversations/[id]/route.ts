/** Spec ref: §7.3 — Get conversation */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Get conversation", action: "get" });
    void ctx;
    return Response.json({ todo: "Get conversation", spec_section: "§7.3" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

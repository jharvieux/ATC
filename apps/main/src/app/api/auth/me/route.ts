/** Spec ref: §7.1 — Get current user */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Get current user", action: "get" });
    void ctx;
    return Response.json({ todo: "Get current user", spec_section: "§7.1" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

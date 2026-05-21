/** Spec ref: §7.3 — List conversations */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "List conversations", action: "get" });
    void ctx;
    return Response.json({ todo: "List conversations", spec_section: "§7.3" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

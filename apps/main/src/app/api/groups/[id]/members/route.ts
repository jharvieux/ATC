/** Spec ref: §7.7 — Add group member */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Add group member", action: "post" });
    void ctx;
    return Response.json({ todo: "Add group member", spec_section: "§7.7" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

/** Spec ref: §7.3 — Set conversation persona */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Set conversation persona", action: "post" });
    void ctx;
    return Response.json({ todo: "Set conversation persona", spec_section: "§7.3" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

/** Spec ref: §7.6 — Cancel booking */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Cancel booking", action: "post" });
    void ctx;
    return Response.json({ todo: "Cancel booking", spec_section: "§7.6" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

/** Spec ref: §7.5 — Send quote to client */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Send quote to client", action: "post" });
    void ctx;
    return Response.json({ todo: "Send quote to client", spec_section: "§7.5" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

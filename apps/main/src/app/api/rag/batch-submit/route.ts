/** Spec ref: §7.8 — Batch submit knowledge chunks */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Batch submit knowledge chunks", action: "post" });
    void ctx;
    return Response.json({ todo: "Batch submit knowledge chunks", spec_section: "§7.8" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

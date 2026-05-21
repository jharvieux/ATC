/** Spec ref: §7.8 — List ingestion queue */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "List ingestion queue", action: "get" });
    void ctx;
    return Response.json({ todo: "List ingestion queue", spec_section: "§7.8" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

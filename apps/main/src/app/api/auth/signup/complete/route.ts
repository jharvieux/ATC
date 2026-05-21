/** Spec ref: §7.1 — Complete signup (tenant provisioning after email confirm) */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "auth", action: "signup:complete" });
    void ctx;
    return Response.json({ todo: "Complete signup / provision tenant", spec_section: "§7.1" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

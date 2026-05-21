/** Spec ref: §7.1 — Transfer session across subdomains */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Transfer session across subdomains", action: "post" });
    void ctx;
    return Response.json({ todo: "Transfer session across subdomains", spec_section: "§7.1" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

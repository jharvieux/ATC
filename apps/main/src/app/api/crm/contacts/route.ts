/** Spec ref: §7.4 — Contacts (list + create) */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "list" });
    void ctx;
    return Response.json({ todo: "List contacts", spec_section: "§7.4" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "create" });
    void ctx;
    return Response.json({ todo: "Create contact", spec_section: "§7.4" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

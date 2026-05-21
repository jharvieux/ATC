/** Spec ref: §7.6 — Booking (get + patch) */

import { assertPermission } from "@/lib/auth/assert-permission";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings", action: "read" });
    void ctx;
    return Response.json({ todo: "Get booking", spec_section: "§7.6" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings", action: "update" });
    void ctx;
    return Response.json({ todo: "Update booking", spec_section: "§7.6" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

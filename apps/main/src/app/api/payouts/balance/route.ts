/** Spec ref: §7.6 — Get payout balance */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Get payout balance", action: "get" });
    void ctx;
    return Response.json({ todo: "Get payout balance", spec_section: "§7.6" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

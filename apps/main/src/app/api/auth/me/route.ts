/** Spec ref: §7.1 — Get current user */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Get current user", action: "get" });
    void ctx;
    return Response.json({ todo: "Get current user", spec_section: "§7.1" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

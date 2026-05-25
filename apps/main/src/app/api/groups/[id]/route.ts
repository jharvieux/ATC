/** Spec ref: §7.7 — Get group */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Get group", action: "get" });
    void ctx;
    return Response.json({ todo: "Get group", spec_section: "§7.7" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

/** Spec ref: §7.2 — Get current legal document */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Get current legal document", action: "get" });
    void ctx;
    return Response.json({ todo: "Get current legal document", spec_section: "§7.2" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

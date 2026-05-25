/** Spec ref: §7.1 — Record consent */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Record consent", action: "post" });
    void ctx;
    return Response.json({ todo: "Record consent", spec_section: "§7.1" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

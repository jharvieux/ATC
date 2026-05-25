/** Spec ref: §7.6 — Create draft booking */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Create draft booking", action: "post" });
    void ctx;
    return Response.json({ todo: "Create draft booking", spec_section: "§7.6" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

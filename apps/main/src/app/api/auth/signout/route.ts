/** Spec ref: §7.1 — Sign out */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Sign out", action: "post" });
    void ctx;
    return Response.json({ todo: "Sign out", spec_section: "§7.1" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

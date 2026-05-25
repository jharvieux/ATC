/** Spec ref: §7.8 — Submit knowledge chunk */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "Submit knowledge chunk", action: "post" });
    void ctx;
    return Response.json({ todo: "Submit knowledge chunk", spec_section: "§7.8" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

/** Spec ref: §7.8 — List knowledge chunks */

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "List knowledge chunks", action: "get" });
    void ctx;
    return Response.json({ todo: "List knowledge chunks", spec_section: "§7.8" }, { status: 501 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

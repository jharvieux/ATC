// BP31 §32.6.1 — List help-doc sections.

export const dynamic = "force-dynamic";

import { assertPermission } from "@/lib/auth/assert-permission";
import { listDocs } from "@/lib/help-ai/docs-loader";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    await assertPermission(req, { resource: "help_docs", action: "read" });
    return Response.json({ items: listDocs() });
  } catch (err) {
    return respondToAuthError(err);
  }
}

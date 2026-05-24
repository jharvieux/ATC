// BP31 §32.6.1 — List help-doc sections.

import { assertPermission } from "@/lib/auth/assert-permission";
import { listDocs } from "@/lib/help-ai/docs-loader";

export async function GET(req: Request): Promise<Response> {
  try {
    await assertPermission(req, { resource: "help_docs", action: "read" });
    return Response.json({ items: listDocs() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}

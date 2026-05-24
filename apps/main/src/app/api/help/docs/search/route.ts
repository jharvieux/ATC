// BP31 §32.6.1 — Search across help docs (in-memory fuzzy).

export const dynamic = "force-dynamic";

import { assertPermission } from "@/lib/auth/assert-permission";
import { searchDocs } from "@/lib/help-ai/docs-loader";

export async function GET(req: Request): Promise<Response> {
  try {
    await assertPermission(req, { resource: "help_docs", action: "read" });
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    if (q.trim().length < 2) {
      return Response.json({ items: [] });
    }
    return Response.json({ items: searchDocs(q) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}

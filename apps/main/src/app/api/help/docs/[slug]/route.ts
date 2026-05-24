// BP31 §32.6.1 — Get a single help doc rendered to HTML.

import { assertPermission } from "@/lib/auth/assert-permission";
import { getDocBySlug } from "@/lib/help-ai/docs-loader";
import { renderDocHtml } from "@/lib/help-ai/markdown-render";

export async function GET(req: Request, { params }: { params: { slug: string } }): Promise<Response> {
  try {
    await assertPermission(req, { resource: "help_docs", action: "read" });
    const doc = getDocBySlug(params.slug);
    if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
    const html = await renderDocHtml(doc);
    return Response.json({
      slug: doc.slug,
      title: doc.title,
      order: doc.order,
      category: doc.category,
      html,
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}

// §TN — Admin: send a travel news article to the RAG pipeline.
// Uses PLATFORM_DEFAULT_TENANT_ID so the submission is platform-level knowledge.
// Sets rag_submitted_at on the article so the UI can prevent re-submission.

import {
  assertPlatformAdmin,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait, safeAwaitRowCount } from "@/lib/db/safe-mutation";
import { createSubmission } from "@/lib/rag-ingest/create-submission";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await assertPlatformAdmin(req);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const tenantId = process.env.PLATFORM_DEFAULT_TENANT_ID;
  if (!tenantId) {
    return Response.json({ error: "PLATFORM_DEFAULT_TENANT_ID_not_configured" }, { status: 503 });
  }

  const { id } = await params;

  const result = await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason: "travel_news_article_rag_submit", operation: "news_articles.rag_submit" },
    async (db, recordQuery) => {
      recordQuery({ op: "select", table: "news_articles" });
      const articles = await safeAwait<
        Array<{ id: string; title: string; url: string; description: string | null; rag_submitted_at: string | null }>
      >(
        db.from("news_articles").select("id, title, url, description, rag_submitted_at").eq("id", id).limit(1),
        "news_articles.fetch_for_rag",
      );

      const article = articles?.[0];
      if (!article) return { error: "not_found" } as const;
      if (article.rag_submitted_at) return { error: "already_submitted" } as const;

      const content = article.description
        ? `${article.title}\n\n${article.description}`
        : article.title;

      const submission = await createSubmission({
        db,
        tenant_id: tenantId,
        submitted_by_user_id: ctx.admin_user_id,
        submission_method: "manual_entry",
        source_url: article.url,
        source_title: article.title,
        original_content: content,
      });

      recordQuery({ op: "update", table: "news_articles" });
      await safeAwaitRowCount(
        db.from("news_articles").update({ rag_submitted_at: new Date().toISOString() }).eq("id", id).select("id"),
        "news_articles.set_rag_submitted_at",
        1,
      );

      return { submission_id: submission.submission_id };
    },
  );

  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 409;
    return Response.json({ error: result.error }, { status });
  }

  return Response.json(result, { status: 201 });
}

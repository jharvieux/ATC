// §TN — Admin: send a travel news article to the RAG pipeline.
// Uses PLATFORM_DEFAULT_TENANT_ID so the submission is platform-level knowledge.
//
// Idempotency: atomically claims the article via a CAS UPDATE
// (WHERE rag_submitted_at IS NULL) before calling createSubmission, so
// concurrent admin POSTs can't both queue duplicate RAG submissions.

import {
  assertPlatformAdminArea,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { createSubmission } from "@/lib/rag-ingest/create-submission";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await assertPlatformAdminArea(req, "travel_news");
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
      // CAS claim: atomically set rag_submitted_at and retrieve the article in
      // one statement. If rag_submitted_at was already set, UPDATE matches 0
      // rows and we return 409 without ever calling createSubmission.
      recordQuery({ op: "update", table: "news_articles" });
      const claimed = await safeAwait<
        Array<{ id: string; title: string; url: string; description: string | null }>
      >(
        db
          .from("news_articles")
          .update({ rag_submitted_at: new Date().toISOString() })
          .eq("id", id)
          .is("rag_submitted_at", null)
          .select("id, title, url, description"),
        "news_articles.claim_for_rag",
      );

      if (!claimed || claimed.length === 0) {
        // Either row doesn't exist or was already claimed.
        const exists = await safeAwait<Array<{ id: string }>>(
          db.from("news_articles").select("id").eq("id", id).limit(1),
          "news_articles.existence_check",
        );
        return exists && exists.length > 0
          ? ({ error: "already_submitted" } as const)
          : ({ error: "not_found" } as const);
      }

      const article = claimed[0]!;
      const content = article.description
        ? `${article.title}\n\n${article.description}`
        : article.title;

      recordQuery({ op: "insert", table: "rag_submissions" });
      const submission = await createSubmission({
        db,
        tenant_id: tenantId,
        submitted_by_user_id: ctx.admin_user_id,
        submission_method: "manual_entry",
        source_url: article.url,
        source_title: article.title,
        original_content: content,
      });

      return { submission_id: submission.submission_id };
    },
  );

  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 409;
    return Response.json({ error: result.error }, { status });
  }

  return Response.json(result, { status: 201 });
}

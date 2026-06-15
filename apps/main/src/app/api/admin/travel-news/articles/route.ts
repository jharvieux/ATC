// §TN — Admin: list travel news articles (visible + hidden).
//
// GET /api/admin/travel-news/articles
//   → { visible: Article[], hidden: Article[] }
//
// Returns up to 100 visible (score ≥ 60) and up to 50 hidden articles,
// newest-first.

import {
  assertPlatformAdminArea,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";

const ARTICLE_COLUMNS =
  "id, title, url, source_name, published_at, relevance_score, is_hidden, rag_submitted_at";

export async function GET(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await assertPlatformAdminArea(req, "travel_news");
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const [visible, hidden] = await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason: "travel_news_articles_read", operation: "news_articles.list" },
    async (db, recordQuery) => {
      recordQuery({ op: "select", table: "news_articles" });
      const [v, h] = await Promise.all([
        safeAwait<Array<Record<string, unknown>>>(
          db
            .from("news_articles")
            .select(ARTICLE_COLUMNS)
            .eq("is_hidden", false)
            .gte("relevance_score", 60)
            .order("published_at", { ascending: false })
            .limit(100),
          "news_articles.list_visible",
        ),
        safeAwait<Array<Record<string, unknown>>>(
          db
            .from("news_articles")
            .select(ARTICLE_COLUMNS)
            .eq("is_hidden", true)
            .order("published_at", { ascending: false })
            .limit(50),
          "news_articles.list_hidden",
        ),
      ]);
      return [v ?? [], h ?? []] as const;
    },
  );

  return Response.json({ visible, hidden });
}

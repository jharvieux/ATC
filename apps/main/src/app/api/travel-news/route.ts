// §TN — Public travel news ticker API.
// No auth required; returns recently scored articles for the chat page ticker.
// Articles with relevance_score < 60 or is_hidden = true are excluded.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

export async function GET(): Promise<Response> {
  const db = createServiceRoleClient();

  const articles = await safeAwait<
    Array<{
      id: string;
      title: string;
      url: string;
      source_name: string | null;
      published_at: string | null;
    }>
  >(
    db
      .from("news_articles")
      .select("id, title, url, source_name, published_at")
      .eq("is_hidden", false)
      .gte("relevance_score", 60)
      .order("published_at", { ascending: false })
      .limit(50),
    "news_articles.ticker",
  );

  return Response.json({ articles: articles ?? [] });
}

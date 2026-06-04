// §TN — Travel news feed refresh.
//
// Runs every 6 hours. Fetches active RSS feeds, keyword-filters items for
// US-cruise-customer relevance, then LLM-scores surviving articles and
// upserts them. Articles older than 7 days are purged.

import { XMLParser } from "fast-xml-parser";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import {
  instrumentedClaudeCall,
  PLATFORM_TENANT_ID,
} from "@/lib/ai/call-wrapper";

// Terms whose presence in title+description indicates relevance.
// Lowercase — compared against lowercased text.
const KEYWORD_ALLOWLIST = [
  "cruise", "cruises", "ship", "sailing", "itinerary", "port of call",
  "carnival", "royal caribbean", "norwegian cruise", "celebrity cruises",
  "princess cruises", "msc cruises", "virgin voyages", "disney cruise",
  "holland america",
  "caribbean", "mediterranean", "alaska cruise", "bahamas", "bermuda",
  "hawaii", "cancun", "cozumel", "cayman", "grand cayman",
  "united airlines", "delta air", "southwest airlines", "american airlines",
  "jetblue", "spirit airlines",
  "marriott", "hilton hotel", "hyatt", "ihg", "wyndham", "best western",
  "travel advisory", "travel warning", "port closure", "hurricane season",
];

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | undefined;
  guid: string;
}

function passesKeywordFilter(item: RssItem): boolean {
  const haystack = `${item.title} ${item.description}`.toLowerCase();
  return KEYWORD_ALLOWLIST.some((kw) => haystack.includes(kw));
}

async function fetchFeedItems(url: string): Promise<RssItem[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml) as Record<string, unknown>;

  // Handle both RSS 2.0 (channel.item) and Atom (feed.entry).
  const channel =
    (parsed.rss as Record<string, unknown> | undefined)?.channel ??
    (parsed.feed as Record<string, unknown> | undefined);
  if (!channel) return [];

  const rawItems: unknown[] = Array.isArray(
    (channel as Record<string, unknown>).item,
  )
    ? ((channel as Record<string, unknown>).item as unknown[])
    : Array.isArray((channel as Record<string, unknown>).entry)
      ? ((channel as Record<string, unknown>).entry as unknown[])
      : [];

  return rawItems
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      const title = String(r.title ?? "").trim();
      // RSS: <link>; Atom: <link href="...">
      const link =
        typeof r.link === "string"
          ? r.link
          : String(
              (r.link as Record<string, string> | undefined)?.[
                "@_href"
              ] ?? "",
            );
      const description = String(
        r.description ?? r.summary ?? r.content ?? "",
      ).replace(/<[^>]+>/g, " ").trim();
      const pubDate =
        typeof r.pubDate === "string"
          ? r.pubDate
          : typeof r.published === "string"
            ? r.published
            : typeof r.updated === "string"
              ? r.updated
              : undefined;
      const guid =
        typeof r.guid === "string"
          ? r.guid
          : typeof r.id === "string"
            ? r.id
            : link || title;
      return { title, link, description, pubDate, guid } as RssItem;
    })
    .filter((item) => item.title && item.link);
}

interface ScoreResult {
  guid: string;
  score: number;
}

async function llmScoreItems(items: RssItem[]): Promise<ScoreResult[]> {
  if (items.length === 0) return [];

  const list = items
    .map((item, i) => `${i + 1}. guid=${JSON.stringify(item.guid)} title=${JSON.stringify(item.title)} desc=${JSON.stringify(item.description.slice(0, 200))}`)
    .join("\n");

  const prompt =
    `Score each article 0-100 for relevance to a US-based cruise travel agency's customers. ` +
    `Score high for: cruise news, US airline/hotel news that affects travelers, popular cruise destination news. ` +
    `Score low for: non-US regional content with no cruise relevance, unrelated topics. ` +
    `Return ONLY a JSON array: [{"guid":"...","score":N}, ...]. No commentary.\n\n` +
    list;

  const { text } = await instrumentedClaudeCall({
    tenant_id: PLATFORM_TENANT_ID,
    model: "claude-haiku-4-5-20251001",
    purpose: "rag_relevance_scoring",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    return JSON.parse(json) as ScoreResult[];
  } catch {
    return [];
  }
}

async function refreshFeed(
  db: ReturnType<typeof createServiceRoleClient>,
  feed: { id: string; url: string; name: string },
): Promise<void> {
  const items = await fetchFeedItems(feed.url);
  const filtered = items.filter(passesKeywordFilter);

  // Score in batches of 20.
  const scored: ScoreResult[] = [];
  for (let i = 0; i < filtered.length; i += 20) {
    const batch = filtered.slice(i, i + 20);
    const results = await llmScoreItems(batch);
    scored.push(...results);
  }

  const scoreMap = new Map(scored.map((r) => [r.guid, r.score]));

  // Upsert all scored articles (including sub-threshold ones — stored but not shown).
  for (const item of filtered) {
    const score = scoreMap.get(item.guid) ?? null;
    const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null;

    await safeAwait(
      db.from("news_articles").upsert(
        {
          feed_id: feed.id,
          guid: item.guid,
          title: item.title,
          url: item.link,
          description: item.description || null,
          published_at: publishedAt,
          source_name: feed.name,
          relevance_score: score,
        },
        { onConflict: "feed_id,guid", ignoreDuplicates: false },
      ),
      "news_articles.upsert",
    );
  }

  await safeAwait(
    db.from("news_feeds").update({ last_fetched_at: new Date().toISOString() }).eq("id", feed.id),
    "news_feeds.update_last_fetched",
  );
}

export const travelNewsRefresh = inngest.createFunction(
  {
    id: "travel-news-refresh",
    triggers: [
      { cron: "0 */6 * * *" },
      { event: "travel-news/manual-refresh" },
    ],
    concurrency: { limit: 1 },
  },
  async () => {
    const db = createServiceRoleClient();

    const feeds = await safeAwait<Array<{ id: string; url: string; name: string }>>(
      db.from("news_feeds").select("id, url, name").eq("is_active", true),
      "news_feeds.list",
    );

    for (const feed of feeds ?? []) {
      try {
        await refreshFeed(db, feed);
      } catch (err) {
        console.error("[travel-news-refresh] feed error", { feed_id: feed.id, url: feed.url, err });
      }
    }

    // Purge articles older than 7 days.
    await safeAwait(
      db.from("news_articles")
        .delete()
        .lt("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      "news_articles.purge_old",
    );

    return { ok: true, feeds_processed: feeds?.length ?? 0 };
  },
);

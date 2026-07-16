// §TN — Travel news feed refresh.
//
// Runs every 6 hours. Fetches active RSS feeds, keyword-filters items for
// US-cruise-customer relevance, then LLM-scores surviving articles and
// upserts them. Articles older than 7 days are purged.

import { XMLParser } from "fast-xml-parser";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { fetchGuarded } from "@/lib/net/ssrf-guard";
import { safeAwait } from "@/lib/db/safe-mutation";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";
import {
  instrumentedClaudeCall,
  PLATFORM_TENANT_ID,
} from "@/lib/ai/call-wrapper";

// #1789 — per-article upsert (unique on feed_id,guid) is independent of
// every other article's; the LLM scoring above it stays batched/serial
// (Claude calls, not touched here).
const UPSERT_CONCURRENCY = 10;

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

const MAX_FEEDS_PER_RUN = 20;
const MAX_ITEMS_PER_FEED = 40;

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
  // F-ssrf-01: feed URL is admin-stored — guard against file://, internal hosts,
  // and redirects to internal addresses (incl. cloud metadata).
  const res = await fetchGuarded(url, { timeoutMs: 10_000 });
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

const HAIKU_MODEL = process.env.TRAVEL_NEWS_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";

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
    model: HAIKU_MODEL,
    purpose: "rag_relevance_scoring",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    return JSON.parse(json) as ScoreResult[];
  } catch (err) {
    console.error("[travel-news-refresh] llmScoreItems parse failed", { err, text: text.slice(0, 200) });
    return [];
  }
}

async function refreshFeed(
  db: ReturnType<typeof createServiceRoleClient>,
  feed: { id: string; url: string; name: string },
): Promise<void> {
  const items = await fetchFeedItems(feed.url);
  const filtered = items.filter(passesKeywordFilter).slice(0, MAX_ITEMS_PER_FEED);

  // #1955 — dedupe by guid before scoring/upserting: without this, two
  // same-link/title items fall back to the same guid, the parallel upserts
  // (onConflict: feed_id,guid) race nondeterministically, and scoring
  // duplicate content both wastes LLM tokens and lets one duplicate's score
  // silently overwrite the other's in scoreMap. Newest pubDate wins the
  // tie-break, deterministically.
  const byGuid = new Map<string, RssItem>();
  for (const item of filtered) {
    const existing = byGuid.get(item.guid);
    if (!existing) {
      byGuid.set(item.guid, item);
      continue;
    }
    const existingTime = existing.pubDate ? Date.parse(existing.pubDate) : NaN;
    const itemTime = item.pubDate ? Date.parse(item.pubDate) : NaN;
    if (!Number.isNaN(itemTime) && (Number.isNaN(existingTime) || itemTime > existingTime)) {
      byGuid.set(item.guid, item);
    }
  }
  const deduped = Array.from(byGuid.values());

  // Score in batches of 20.
  const scored: ScoreResult[] = [];
  for (let i = 0; i < deduped.length; i += 20) {
    const batch = deduped.slice(i, i + 20);
    const results = await llmScoreItems(batch);
    scored.push(...results);
  }

  const scoreMap = new Map(scored.map((r) => [r.guid, r.score]));

  // Upsert all scored articles (including sub-threshold ones — stored but not shown).
  await mapWithConcurrency(deduped, UPSERT_CONCURRENCY, (item) => {
    const score = scoreMap.get(item.guid) ?? null;
    const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null;

    return safeAwait(
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
  });

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

    const capped = (feeds ?? []).slice(0, MAX_FEEDS_PER_RUN);
    let failures = 0;
    for (const feed of capped) {
      try {
        await refreshFeed(db, feed);
      } catch (err) {
        failures++;
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

    if (failures > 0 && failures === capped.length) {
      throw new Error(`[travel-news-refresh] all ${failures} feeds failed — marking run as failed`);
    }

    return { ok: true, feeds_processed: capped.length, failures };
  },
);

// #1955 — after #1789 parallelized the per-article upsert, two items that
// share a link/title (no <guid> in the feed) fall back to the same guid.
// The upsert's onConflict target is (feed_id,guid), so concurrent writes to
// that same key raced — whichever landed last won nondeterministically.
// This pins the fix: dedupe by guid before the fan-out, newest pubDate wins.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

let currentFeedXml = "";

vi.mock("@/lib/net/ssrf-guard", () => ({
  fetchGuarded: vi.fn(async () => ({ ok: true, text: async () => currentFeedXml })),
}));

vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: vi.fn(async () => ({ text: "[]", raw: {} })),
  PLATFORM_TENANT_ID: "platform-tenant",
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async (p: Promise<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    if (error) throw new Error(String(error));
    return data;
  },
}));

interface UpsertCall {
  payload: { feed_id: string; guid: string; title: string; published_at: string | null };
  opts: unknown;
}

let upsertCalls: UpsertCall[];

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "news_feeds") {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: [{ id: "feed-1", url: "https://example.test/rss", name: "Example Feed" }],
                error: null,
              }),
          }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      }
      if (table === "news_articles") {
        return {
          upsert: (payload: UpsertCall["payload"], opts: unknown) => {
            upsertCalls.push({ payload, opts });
            return Promise.resolve({ data: null, error: null });
          },
          delete: () => ({ lt: () => Promise.resolve({ data: null, error: null }) }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

// Two items share a link (no <guid> in either) — newer pubDate listed FIRST,
// older SECOND. If the dedupe just kept "whichever iterates last" this would
// pick the older item; the newest-pubDate rule must pick the first one.
const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Newer cruise itinerary change</title>
    <link>https://news.test/article</link>
    <description>cruise ship itinerary update</description>
    <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Older cruise itinerary change</title>
    <link>https://news.test/article</link>
    <description>cruise ship itinerary update</description>
    <pubDate>Tue, 01 Jul 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

// Same pair, but the newer item is listed SECOND — the dedupe must not
// silently depend on scan order to pick the newest.
const NEWER_SECOND_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Older cruise itinerary change</title>
    <link>https://news.test/article-2</link>
    <description>cruise ship itinerary update</description>
    <pubDate>Tue, 01 Jul 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Newer cruise itinerary change</title>
    <link>https://news.test/article-2</link>
    <description>cruise ship itinerary update</description>
    <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

// Identical pubDate on both — the tie-break must be deterministic (first-seen
// wins), not "whichever the Map happened to keep."
const IDENTICAL_PUBDATE_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>First-seen cruise itinerary change</title>
    <link>https://news.test/article-3</link>
    <description>cruise ship itinerary update</description>
    <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Second cruise itinerary change</title>
    <link>https://news.test/article-3</link>
    <description>cruise ship itinerary update</description>
    <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

// Valid date listed first, missing pubDate second — the valid-date item must win.
const VALID_THEN_MISSING_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Valid date cruise itinerary change</title>
    <link>https://news.test/article-4</link>
    <description>cruise ship itinerary update</description>
    <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>No date cruise itinerary change</title>
    <link>https://news.test/article-4</link>
    <description>cruise ship itinerary update</description>
  </item>
</channel></rss>`;

// Missing pubDate listed first, valid date second — the valid-date item must
// win regardless of scan order.
const MISSING_THEN_VALID_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>No date cruise itinerary change</title>
    <link>https://news.test/article-5</link>
    <description>cruise ship itinerary update</description>
  </item>
  <item>
    <title>Valid date cruise itinerary change</title>
    <link>https://news.test/article-5</link>
    <description>cruise ship itinerary update</description>
    <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

// Neither item has a parseable pubDate — falls back to first-seen.
const BOTH_MISSING_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>First-seen no-date item</title>
    <link>https://news.test/article-6</link>
    <description>cruise ship itinerary update</description>
  </item>
  <item>
    <title>Second no-date item</title>
    <link>https://news.test/article-6</link>
    <description>cruise ship itinerary update</description>
  </item>
</channel></rss>`;

async function runCron(): Promise<unknown> {
  vi.resetModules();
  const mod = (await import("@/inngest/travel-news-refresh")) as unknown as {
    travelNewsRefresh: { __handler: () => Promise<unknown> };
  };
  return mod.travelNewsRefresh.__handler();
}

beforeEach(() => {
  vi.clearAllMocks();
  upsertCalls = [];
  currentFeedXml = FEED_XML;
});

describe("travelNewsRefresh — deterministic guid dedupe (#1955)", () => {
  it("dedupes same-link items to a single upsert, newest pubDate winning", async () => {
    await runCron();

    const forThisGuid = upsertCalls.filter((c) => c.payload.guid === "https://news.test/article");
    expect(forThisGuid).toHaveLength(1);
    expect(forThisGuid[0]!.payload.title).toBe("Newer cruise itinerary change");
    expect(forThisGuid[0]!.payload.published_at).toBe(
      new Date("Wed, 02 Jul 2026 10:00:00 GMT").toISOString(),
    );
  });

  it("picks the newer item when it is listed second", async () => {
    currentFeedXml = NEWER_SECOND_XML;
    await runCron();

    const forThisGuid = upsertCalls.filter((c) => c.payload.guid === "https://news.test/article-2");
    expect(forThisGuid).toHaveLength(1);
    expect(forThisGuid[0]!.payload.title).toBe("Newer cruise itinerary change");
    expect(forThisGuid[0]!.payload.published_at).toBe(
      new Date("Wed, 02 Jul 2026 10:00:00 GMT").toISOString(),
    );
  });

  it("keeps the first-seen item when pubDates are identical", async () => {
    currentFeedXml = IDENTICAL_PUBDATE_XML;
    await runCron();

    const forThisGuid = upsertCalls.filter((c) => c.payload.guid === "https://news.test/article-3");
    expect(forThisGuid).toHaveLength(1);
    expect(forThisGuid[0]!.payload.title).toBe("First-seen cruise itinerary change");
  });

  it("prefers the valid-date item over a missing-pubDate item, valid listed first", async () => {
    currentFeedXml = VALID_THEN_MISSING_XML;
    await runCron();

    const forThisGuid = upsertCalls.filter((c) => c.payload.guid === "https://news.test/article-4");
    expect(forThisGuid).toHaveLength(1);
    expect(forThisGuid[0]!.payload.title).toBe("Valid date cruise itinerary change");
    expect(forThisGuid[0]!.payload.published_at).not.toBeNull();
  });

  it("prefers the valid-date item over a missing-pubDate item, valid listed second", async () => {
    currentFeedXml = MISSING_THEN_VALID_XML;
    await runCron();

    const forThisGuid = upsertCalls.filter((c) => c.payload.guid === "https://news.test/article-5");
    expect(forThisGuid).toHaveLength(1);
    expect(forThisGuid[0]!.payload.title).toBe("Valid date cruise itinerary change");
    expect(forThisGuid[0]!.payload.published_at).not.toBeNull();
  });

  it("falls back to first-seen when neither item has a parseable pubDate", async () => {
    currentFeedXml = BOTH_MISSING_XML;
    await runCron();

    const forThisGuid = upsertCalls.filter((c) => c.payload.guid === "https://news.test/article-6");
    expect(forThisGuid).toHaveLength(1);
    expect(forThisGuid[0]!.payload.title).toBe("First-seen no-date item");
    expect(forThisGuid[0]!.payload.published_at).toBeNull();
  });
});

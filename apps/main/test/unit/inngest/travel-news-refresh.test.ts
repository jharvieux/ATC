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

vi.mock("@/lib/net/ssrf-guard", () => ({
  fetchGuarded: vi.fn(async () => ({ ok: true, text: async () => FEED_XML })),
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
});

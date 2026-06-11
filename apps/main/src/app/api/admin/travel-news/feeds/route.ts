// §TN — Admin: list and create travel news feeds.
//
// GET  /api/admin/travel-news/feeds  → { feeds: [...] }
// POST /api/admin/travel-news/feeds  → { feed: { id, name, url, is_active, last_fetched_at, created_at } }

import {
  assertPlatformRole,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";

export async function GET(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const feeds = await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason: "travel_news_feeds_read", operation: "news_feeds.list" },
    async (db, recordQuery) => {
      recordQuery({ op: "select", table: "news_feeds" });
      return await safeAwait<
        Array<{
          id: string;
          name: string;
          url: string;
          is_active: boolean;
          last_fetched_at: string | null;
          created_at: string;
        }>
      >(
        db.from("news_feeds").select("id, name, url, is_active, last_fetched_at, created_at").order("created_at"),
        "news_feeds.list",
      );
    },
  );

  return Response.json({ feeds: feeds ?? [] });
}

export async function POST(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await assertPlatformRole(req, ["superadmin", "reviewer"]);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: { url?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.url || typeof body.url !== "string") {
    return Response.json({ error: "url_required" }, { status: 400 });
  }
  if (!body.name || typeof body.name !== "string") {
    return Response.json({ error: "name_required" }, { status: 400 });
  }

  try {
    new URL(body.url);
  } catch {
    return Response.json({ error: "invalid_url" }, { status: 400 });
  }

  const feed = await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason: "travel_news_feed_create", operation: "news_feeds.insert" },
    async (db, recordQuery) => {
      recordQuery({ op: "insert", table: "news_feeds" });
      const rows = await safeAwait<Array<Record<string, unknown>>>(
        db.from("news_feeds").insert({ url: body.url, name: body.name }).select().limit(1),
        "news_feeds.insert",
      );
      return rows?.[0] ?? null;
    },
  );

  if (!feed) return Response.json({ error: "insert_failed" }, { status: 500 });
  return Response.json({ feed }, { status: 201 });
}

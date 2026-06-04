// §TN — Admin: update or delete a travel news feed.
//
// PATCH /api/admin/travel-news/feeds/[id]  → { feed: {...} }
//   body: { name?: string, url?: string, is_active?: boolean }
// DELETE /api/admin/travel-news/feeds/[id] → 204

import {
  assertPlatformAdmin,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait, safeAwaitRowCount } from "@/lib/db/safe-mutation";

export async function PATCH(
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

  const { id } = await params;

  let body: { name?: string; url?: string; is_active?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.url !== undefined) {
    try {
      new URL(body.url);
    } catch {
      return Response.json({ error: "invalid_url" }, { status: 400 });
    }
  }

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.is_active !== undefined) updates.is_active = body.is_active;

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "no_fields" }, { status: 400 });
  }

  const feed = await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason: "travel_news_feed_update", operation: "news_feeds.update" },
    async (db, recordQuery) => {
      recordQuery({ op: "update", table: "news_feeds" });
      const rows = await safeAwait<Array<Record<string, unknown>>>(
        db.from("news_feeds").update(updates).eq("id", id).select().limit(1),
        "news_feeds.update",
      );
      return rows?.[0] ?? null;
    },
  );

  if (!feed) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ feed });
}

export async function DELETE(
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

  const { id } = await params;

  await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason: "travel_news_feed_delete", operation: "news_feeds.delete" },
    async (db, recordQuery) => {
      recordQuery({ op: "delete", table: "news_feeds" });
      await safeAwaitRowCount(
        db.from("news_feeds").delete().eq("id", id).select("id"),
        "news_feeds.delete",
        1,
      );
    },
  );

  return new Response(null, { status: 204 });
}

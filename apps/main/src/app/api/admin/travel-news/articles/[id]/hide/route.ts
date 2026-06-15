// §TN — Admin: hide or unhide a travel news article.
//
// POST  → set is_hidden = true  (hide from ticker)
// PATCH → set is_hidden = false (restore to ticker)

import {
  assertPlatformAdminArea,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";

async function setHidden(
  req: Request,
  id: string,
  isHidden: boolean,
): Promise<Response> {
  let ctx;
  try {
    ctx = await assertPlatformAdminArea(req, "travel_news");
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const reason = isHidden ? "travel_news_article_hide" : "travel_news_article_unhide";
  const opCtx = isHidden ? "news_articles.hide" : "news_articles.unhide";

  const updated = await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason, operation: opCtx },
    async (db, recordQuery) => {
      recordQuery({ op: "update", table: "news_articles" });
      const rows = await safeAwait<Array<{ id: string }>>(
        db.from("news_articles").update({ is_hidden: isHidden }).eq("id", id).select("id"),
        opCtx,
      );
      return rows ?? [];
    },
  );

  if (updated.length === 0) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ is_hidden: isHidden });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return setHidden(req, id, true);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return setHidden(req, id, false);
}

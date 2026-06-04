// §TN — Admin: hide or unhide a travel news article.
//
// POST  → set is_hidden = true  (hide from ticker)
// PATCH → set is_hidden = false (restore to ticker)

import {
  assertPlatformAdmin,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwaitRowCount } from "@/lib/db/safe-mutation";

async function setHidden(
  req: Request,
  id: string,
  isHidden: boolean,
): Promise<Response> {
  let ctx;
  try {
    ctx = await assertPlatformAdmin(req);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const reason = isHidden ? "travel_news_article_hide" : "travel_news_article_unhide";
  const opCtx = isHidden ? "news_articles.hide" : "news_articles.unhide";

  await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason, operation: opCtx },
    async (db, recordQuery) => {
      recordQuery({ op: "update", table: "news_articles" });
      await safeAwaitRowCount(
        db.from("news_articles").update({ is_hidden: isHidden }).eq("id", id).select("id"),
        opCtx,
        1,
      );
    },
  );

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

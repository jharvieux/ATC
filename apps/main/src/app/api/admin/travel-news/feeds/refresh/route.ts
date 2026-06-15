// §TN — Admin: manually trigger a travel news feed refresh.
// Sends the Inngest event that the travel-news-refresh function also listens to.

import { inngest } from "@/inngest/client";
import {
  assertPlatformAdminArea,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

export async function POST(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await assertPlatformAdminArea(req, "travel_news");
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  await withPlatformAdminAudit(
    { admin_user_id: ctx.admin_user_id, reason: "travel_news_manual_refresh", operation: "news_feeds.manual_refresh_trigger" },
    async (_db, _recordQuery) => {
      await inngest.send({ name: "travel-news/manual-refresh", data: {} });
    },
  );

  return Response.json({ queued: true });
}

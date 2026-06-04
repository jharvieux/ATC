// §TN — Admin: manually trigger a travel news feed refresh.
// Sends the Inngest event that the travel-news-refresh function also listens to.

import { inngest } from "@/inngest/client";
import {
  assertPlatformAdmin,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";

export async function POST(req: Request): Promise<Response> {
  try {
    await assertPlatformAdmin(req);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  await inngest.send({ name: "travel-news/manual-refresh", data: {} });

  return Response.json({ queued: true });
}

// §23.3 — Unsubscribe link handler (CAN-SPAM).
// GET /api/email/unsubscribe?token=<signed-token>
//
// Token is verified, then the appropriate email_suppressions row is upserted.
// Returns a redirect to /email/unsubscribe-confirmed.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { safeAwait } from "@/lib/db/safe-mutation";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  const payload = verifyUnsubscribeToken(token);
  if (!payload) {
    return new Response("Invalid or expired token", { status: 400 });
  }

  const { email, tenant_id, category } = payload;

  const reason =
    category === "marketing"
      ? "unsubscribe_marketing"
      : category === "travel_news"
        ? "unsubscribe_travel_news"
        : "unsubscribe_all";

  const svc = createServiceRoleClient();
  await safeAwait(svc.from("email_suppressions").upsert(
    { tenant_id, email_address: email, reason, suppressed_at: new Date().toISOString() },
    { onConflict: "tenant_id,email_address,reason" },
  ), "email_suppressions.upsert");

  return Response.redirect(new URL("/email/unsubscribe-confirmed", url.origin));
}

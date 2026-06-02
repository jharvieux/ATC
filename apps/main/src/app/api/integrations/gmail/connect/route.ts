// §23.9 — Gmail inbound OAuth connect.
//
// The Pub/Sub webhook (apps/main/src/app/api/webhooks/gmailpubsub) and
// the per-tenant health endpoint (./health) are both live. The remaining
// gap is the user-initiated OAuth bootstrap: redirect the tenant admin
// to Google's consent screen, then on /callback persist an encrypted
// refresh token and call gmail.users.watch() to subscribe to the
// Pub/Sub topic. The full implementation is gated on the operator
// completing the GCP setup in docs/runbooks/gmail-inbound-setup.md and
// populating the GMAIL_OAUTH_* + GMAIL_PUBSUB_* env vars listed there.
//
// Until those are present we return 501 — the route exists so tenant-
// admin UI can call it without 404, and the response body points the
// operator at the runbook.

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    await assertPermission(req, { resource: "integrations.gmail", action: "connect" });

    const configured =
      !!process.env.GMAIL_OAUTH_CLIENT_ID &&
      !!process.env.GMAIL_OAUTH_CLIENT_SECRET &&
      !!process.env.GMAIL_PUBSUB_TOPIC;

    return Response.json(
      {
        status: "not_implemented",
        gcp_configured: configured,
        message: configured
          ? "GCP env vars are present but the OAuth start flow has not been wired. " +
            "Follow Step 5 of docs/runbooks/gmail-inbound-setup.md to implement."
          : "Gmail inbound OAuth flow is not yet configured. " +
            "Follow docs/runbooks/gmail-inbound-setup.md to complete GCP setup + Vercel env vars.",
        runbook: "docs/runbooks/gmail-inbound-setup.md",
      },
      { status: 501 },
    );
  } catch (err) {
    return respondToAuthError(err);
  }
}

// §23.9 — Gmail inbound OAuth connect (stub).
//
// Initiates Gmail OAuth flow with gmail.modify + gmail.readonly scopes.
// Pub/Sub topic + push subscription setup requires GCP project config —
// see docs/runbooks/gmail-inbound-setup.md.

import { assertPermission } from "@/lib/auth/assert-permission";

// TODO(gmail-pubsub): implement full OAuth flow using the APP_ENCRYPTION_KEY_*
// framework from BP14 to encrypt the refresh token at rest.
export async function POST(req: Request): Promise<Response> {
  await assertPermission(req, { resource: "integrations.gmail", action: "connect" });

  return Response.json(
    {
      status: "not_implemented",
      message:
        "Gmail inbound OAuth flow is not yet configured. " +
        "Follow the runbook at docs/runbooks/gmail-inbound-setup.md to complete GCP setup, " +
        "then wire this endpoint to initiate the OAuth authorization URL.",
      next_step: "See docs/runbooks/gmail-inbound-setup.md",
    },
    { status: 501 },
  );
}

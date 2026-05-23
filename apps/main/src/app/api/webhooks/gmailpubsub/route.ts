// §23.9 — Gmail Pub/Sub inbound message handler (stub).
//
// When the GCP Pub/Sub push subscription is configured (see
// docs/runbooks/gmail-inbound-setup.md), Pub/Sub pushes to this endpoint.
// The handler should: verify the Pub/Sub token, parse email metadata,
// match to existing contacts/conversations, run Haiku summary, surface in CRM.
//
// TODO(gmail-pubsub): implement once GCP project is set up and tenant OAuth
// refresh token is stored via the APP_ENCRYPTION_KEY_* framework.

export async function POST(_req: Request): Promise<Response> {
  return Response.json(
    {
      status: "not_implemented",
      message: "Gmail Pub/Sub handler not yet wired. See docs/runbooks/gmail-inbound-setup.md.",
    },
    { status: 501 },
  );
}

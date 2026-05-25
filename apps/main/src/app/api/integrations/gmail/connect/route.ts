// BP34 §34.2 / §23.9 — Gmail OAuth: kick off authorization.
//
// Returns the Google OAuth authorize URL the client should redirect to.
// state encodes (tenant_id, user_id, nonce) and is verified by the
// callback. Signed with HMAC against APP_OAUTH_STATE_SECRET so a
// forged state can't smuggle a different tenant.

import { createHmac, randomBytes } from "node:crypto";
import { assertPermission } from "@/lib/auth/assert-permission";
import { buildAuthorizationUrl } from "@/lib/gmail/oauth";

export async function POST(req: Request): Promise<Response> {
  const { ctx, user } = await assertPermission(req, {
    resource: "integrations.gmail",
    action: "connect",
  });

  const secret = process.env.APP_OAUTH_STATE_SECRET;
  if (!secret) {
    return Response.json({ error: "server_misconfig:APP_OAUTH_STATE_SECRET_missing" }, { status: 500 });
  }

  const nonce = randomBytes(16).toString("base64url");
  const payload = `${ctx.tenant_id}.${user.id}.${nonce}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  const state = `${payload}.${sig}`;

  return Response.json({ authorize_url: buildAuthorizationUrl({ state }) });
}

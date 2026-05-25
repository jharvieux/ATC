// BP34 §34.2 / §23.9 — Gmail OAuth callback.
//
// Google redirects here after user consent with ?code + ?state.
// We verify state HMAC, exchange code for tokens, encrypt the refresh
// token, profile-lookup the email, start the Pub/Sub watch, persist
// to gmail_oauth_tokens.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { encryptCredential } from "@/lib/crypto/credential-cipher";
import {
  exchangeCodeForTokens,
  getProfileEmail,
  startGmailWatch,
} from "@/lib/gmail/oauth";
import { writeAuditLog } from "@/lib/audit/write";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return Response.json({ error: `oauth_provider_error:${error}` }, { status: 400 });
  }
  if (!code || !state) {
    return Response.json({ error: "missing_code_or_state" }, { status: 400 });
  }

  const secret = process.env.APP_OAUTH_STATE_SECRET;
  if (!secret) {
    return Response.json({ error: "server_misconfig:APP_OAUTH_STATE_SECRET_missing" }, { status: 500 });
  }

  // state = "<tenant_id>.<user_id>.<nonce>.<sig>"
  const parts = state.split(".");
  if (parts.length !== 4) {
    return Response.json({ error: "invalid_state_shape" }, { status: 400 });
  }
  const [tenant_id, user_id, nonce, sig] = parts as [string, string, string, string];
  const expectedSig = createHmac("sha256", secret).update(`${tenant_id}.${user_id}.${nonce}`).digest("base64url");
  if (
    expectedSig.length !== sig.length ||
    !timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig))
  ) {
    return Response.json({ error: "state_signature_invalid" }, { status: 400 });
  }

  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    return Response.json(
      { error: `oauth_exchange_failed:${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  let email: string;
  try {
    email = await getProfileEmail(tokens.access_token);
  } catch (err) {
    return Response.json(
      { error: `gmail_profile_failed:${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  let watch: Awaited<ReturnType<typeof startGmailWatch>>;
  try {
    watch = await startGmailWatch({ access_token: tokens.access_token });
  } catch (err) {
    return Response.json(
      { error: `gmail_watch_start_failed:${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const encrypted = encryptCredential(tokens.refresh_token);
  const svc = createServiceRoleClient();
  const now = new Date().toISOString();
  const { error: upErr } = await svc
    .from("gmail_oauth_tokens")
    .upsert(
      {
        tenant_id,
        encrypted_refresh_token: encrypted.ciphertext,
        encryption_key_version: encrypted.key_id,
        health_status: "connected",
        last_healthy_at: now,
        last_health_check_at: now,
        last_health_error: null,
        pubsub_watch_expires_at: new Date(watch.expiration).toISOString(),
        pubsub_history_id: watch.historyId,
        connected_email: email,
        connected_at: now,
      },
      { onConflict: "tenant_id" },
    );
  if (upErr) {
    return Response.json({ error: `token_persist_failed:${upErr.message}` }, { status: 500 });
  }

  await writeAuditLog({
    tenant_id,
    actor_user_id: user_id,
    actor_type: "user",
    action: "integrations.gmail.connected",
    resource_type: "gmail_oauth_tokens",
    resource_id: tenant_id,
    context: { connected_email: email },
  });

  // Redirect the user back to the CRM integrations settings page.
  const appUrl = process.env.PLATFORM_APP_URL ?? "";
  return Response.redirect(`${appUrl}/settings/integrations/gmail?connected=1`, 302);
}

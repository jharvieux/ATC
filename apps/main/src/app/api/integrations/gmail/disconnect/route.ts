// BP34 §34.2 / §23.9 — Gmail disconnect.
//
// Stops the Pub/Sub watch, revokes the refresh token at Google, clears
// the row (or sets health_status='disconnected' + null tokens —
// preserves the audit row).

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { decryptCredential } from "@/lib/crypto/credential-cipher";
import { mintAccessTokenFromRefresh, revokeToken, stopGmailWatch } from "@/lib/gmail/oauth";
import { writeAuditLog } from "@/lib/audit/write";

export async function POST(req: Request): Promise<Response> {
  const { ctx, user } = await assertPermission(req, {
    resource: "integrations.gmail",
    action: "disconnect",
  });

  const svc = createServiceRoleClient();
  const { data: tokenRow } = await svc
    .from("gmail_oauth_tokens")
    .select("encrypted_refresh_token, encryption_key_version, health_status")
    .eq("tenant_id", ctx.tenant_id)
    .maybeSingle();
  if (!tokenRow) return Response.json({ ok: true, note: "no_active_connection" });

  const r = tokenRow as { encrypted_refresh_token: string | null; encryption_key_version: string | null; health_status: string };

  // Best-effort stop + revoke. Even if Google fails, we still clear local
  // state so the tenant can re-connect with a fresh consent.
  if (r.encrypted_refresh_token && r.encryption_key_version) {
    const decrypted = decryptCredential({
      ciphertext: r.encrypted_refresh_token,
      key_id: r.encryption_key_version,
    });
    if (decrypted.ok) {
      try {
        const access = await mintAccessTokenFromRefresh(decrypted.value);
        try {
          await stopGmailWatch({ access_token: access });
        } catch (err) {
          console.warn("[gmail-disconnect] stopGmailWatch failed:", err);
        }
        try {
          await revokeToken(decrypted.value);
        } catch (err) {
          console.warn("[gmail-disconnect] revokeToken failed:", err);
        }
      } catch (err) {
        console.warn("[gmail-disconnect] could not mint access for revocation:", err);
      }
    }
  }

  const now = new Date().toISOString();
  await svc
    .from("gmail_oauth_tokens")
    .update({
      encrypted_refresh_token: null,
      encryption_key_version: null,
      health_status: "disconnected",
      last_health_check_at: now,
      last_health_error: null,
      pubsub_watch_expires_at: null,
      pubsub_history_id: null,
      connected_email: null,
      connected_at: null,
    })
    .eq("tenant_id", ctx.tenant_id);

  await writeAuditLog({
    tenant_id: ctx.tenant_id,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integrations.gmail.disconnected",
    resource_type: "gmail_oauth_tokens",
    resource_id: ctx.tenant_id,
  });

  return Response.json({ ok: true });
}

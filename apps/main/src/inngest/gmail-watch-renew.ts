// BP34 §34.2.4 — Pub/Sub watch must be renewed every 7 days or Gmail
// stops pushing. Daily cron renews any watch within 2 days of expiry.
//
// Kill-switch: BP34_GMAIL_WATCH_RENEW_DISABLED=true.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { decryptCredential } from "@/lib/crypto/credential-cipher";
import { mintAccessTokenFromRefresh, startGmailWatch } from "@/lib/gmail/oauth";

const RENEW_WINDOW_HOURS = 48;

export const gmailWatchRenew = inngest.createFunction(
  {
    id: "gmail-watch-renew",
    triggers: [{ cron: "0 2 * * *" }], // daily 02:00 UTC
  },
  async () => {
    if (process.env.BP34_GMAIL_WATCH_RENEW_DISABLED === "true") {
      return { skipped: true, reason: "BP34_GMAIL_WATCH_RENEW_DISABLED=true" };
    }

    const svc = createServiceRoleClient();
    const cutoff = new Date(Date.now() + RENEW_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const { data, error } = await svc
      .from("gmail_oauth_tokens")
      .select("tenant_id, encrypted_refresh_token, encryption_key_version, pubsub_watch_expires_at, health_status")
      .eq("health_status", "connected")
      .lte("pubsub_watch_expires_at", cutoff);
    if (error) return { error: error.message };

    type Row = {
      tenant_id: string;
      encrypted_refresh_token: string | null;
      encryption_key_version: string | null;
      pubsub_watch_expires_at: string | null;
      health_status: string;
    };

    let renewed = 0;
    let failed = 0;

    for (const r of (data ?? []) as Row[]) {
      if (!r.encrypted_refresh_token || !r.encryption_key_version) {
        failed++;
        continue;
      }
      const decrypted = decryptCredential({
        ciphertext: r.encrypted_refresh_token,
        key_id: r.encryption_key_version,
      });
      if (!decrypted.ok) {
        failed++;
        await markUnhealthy(svc, r.tenant_id, "token_expired", `decrypt:${decrypted.error.code}`);
        continue;
      }
      try {
        const access = await mintAccessTokenFromRefresh(decrypted.value);
        const watch = await startGmailWatch({ access_token: access });
        await svc
          .from("gmail_oauth_tokens")
          .update({
            pubsub_watch_expires_at: new Date(watch.expiration).toISOString(),
            pubsub_history_id: watch.historyId,
            last_healthy_at: new Date().toISOString(),
            last_health_check_at: new Date().toISOString(),
            last_health_error: null,
          })
          .eq("tenant_id", r.tenant_id);
        renewed++;
      } catch (err) {
        failed++;
        await markUnhealthy(
          svc,
          r.tenant_id,
          "token_expired",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return { renewed, failed, examined: data?.length ?? 0 };
  },
);

async function markUnhealthy(
  svc: ReturnType<typeof createServiceRoleClient>,
  tenant_id: string,
  status: "token_expired" | "revoked" | "disconnected",
  error: string,
): Promise<void> {
  await svc
    .from("gmail_oauth_tokens")
    .update({
      health_status: status,
      last_health_check_at: new Date().toISOString(),
      last_health_error: error,
    })
    .eq("tenant_id", tenant_id);
}

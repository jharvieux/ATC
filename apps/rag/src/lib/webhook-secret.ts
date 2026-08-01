import { verifyWebhookSignature } from "@atc/contracts";

// #2004 / D-091 #28 — the RAG_WEBHOOK_SECRET rotation set. Main signs with
// _CURRENT (falling back to the legacy unsuffixed var); rag verifies against
// every configured member so the secret can rotate with zero downtime.
export function ragWebhookSecrets(): string[] {
  return [
    process.env.RAG_WEBHOOK_SECRET_CURRENT,
    process.env.RAG_WEBHOOK_SECRET_PREVIOUS,
    process.env.RAG_WEBHOOK_SECRET,
  ].filter((s): s is string => !!s);
}

// Verifies against every configured secret (no early exit) so which slot
// matched doesn't leak via timing. Fail-closed: returns false when no secret
// is configured — routes 500 on that case before calling this.
//
// webhook-replay-allow: this module only verifies the HMAC; replay protection
// lives in each consumer route — monotonic source_revision guards in
// tenant-events/platform-settings-events, Redis dedup fingerprint in feedback
// (#1385/F-rag-wh-02).
export async function verifyRagWebhookSignature(
  rawBody: string,
  providedSignature: string | null | undefined,
): Promise<boolean> {
  let ok = false;
  for (const secret of ragWebhookSecrets()) {
    if (await verifyWebhookSignature(secret, rawBody, providedSignature)) ok = true;
  }
  return ok;
}

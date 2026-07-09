// D-041 follow-up — Publish platform_settings change events to the RAG service.
//
// Mirrors publish-tenant-event.ts (§8.7). Same HMAC signature pattern, same
// 3-retry exponential backoff (1s/5s/30s), same fallback to pending_rag_sync
// for the cron to drain. The originating admin handler is NOT blocked on RAG
// sync — failures are logged + queued; the user-facing PUT returns success.
//
// Service-role import permitted: publishes to external service after DB write.
// Add to no-direct-service-role-import allowlist.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { hmacHexSign, type PlatformEvent, type PlatformEventType, type PlatformSettingsEventPayload } from "@atc/contracts";

export type { PlatformEvent, PlatformEventType, PlatformSettingsEventPayload };

// Keys that the rag side actually consumes. Sending anything else is a
// privacy / surface-area concern (e.g. supervisor_slur_deny_list contains
// raw slurs we don't want to leak across project boundaries). The publish
// function silently filters non-allowed keys; if the resulting payload is
// empty, no webhook fires.
//
// Add a key here when you wire a new platform_settings consumer into rag.
const SYNC_ELIGIBLE_KEYS: ReadonlySet<string> = new Set([
  // §6.10 feedback knobs read by compute_feedback_factor (rag migration 0005).
  "feedback_adjustment_limit",
  "feedback_min_signal_count",
  "feedback_period_days",
  "feedback_decay_halflife_days",
  // BP22 §6 retrieval composite weights — added to this allowlist when the
  // BP22 rag migration that reads them lands. Until then, keep them out so
  // the rag-side row doesn't accumulate orphan data.
]);

export function isSyncEligibleKey(key: string): boolean {
  return SYNC_ELIGIBLE_KEYS.has(key);
}

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

// Queue a platform event for the rag-sync-retry cron to redeliver. Shared by
// the missing-config and retries-exhausted paths so neither silently drops
// (#1595 — the missing-config path previously logged and returned, dropping the
// event; tenant events already queued in the same situation). tenant_id is NULL
// for platform-scope events (the pending_rag_sync CHECK constraint allows it).
async function queuePendingPlatformSync(event: PlatformEvent, lastError: string | undefined): Promise<void> {
  console.warn("[rag-sync] queuing platform event for retry", {
    event_type: event.event_type,
    changed_keys: event.payload.changes.map((c) => c.key),
    last_error: lastError,
  });
  try {
    const db = createServiceRoleClient();
    await safeAwait(db.from("pending_rag_sync").insert({
      tenant_id: null,
      event_type: event.event_type,
      payload: event.payload,
      source_revision: event.source_revision,
      last_error: lastError,
    }), "pending_rag_sync.insert");
  } catch (dbErr) {
    console.error("[rag-sync] Failed to insert platform event into pending_rag_sync:", dbErr);
  }
}

async function attemptPost(url: string, body: string, signature: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": signature,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`RAG platform-settings-events returned ${res.status}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function publishPlatformEvent(event: PlatformEvent): Promise<void> {
  // Filter to keys the rag side actually consumes FIRST, so a missing-config
  // event is queued with only the eligible keys (and an all-ineligible event
  // exits before touching config). See SYNC_ELIGIBLE_KEYS for the rationale.
  const filtered = event.payload.changes.filter((c) => isSyncEligibleKey(c.key));
  const dropped = event.payload.changes.filter((c) => !isSyncEligibleKey(c.key));
  if (dropped.length > 0) {
    console.warn("[rag-sync] dropping non-sync-eligible platform_settings keys", {
      dropped_keys: dropped.map((c) => c.key),
    });
  }
  if (filtered.length === 0) {
    return; // Nothing to sync.
  }
  const toPublish: PlatformEvent = {
    ...event,
    payload: { changes: filtered },
  };

  const ragUrl = process.env.RAG_SERVICE_URL;
  const secret = process.env.RAG_WEBHOOK_SECRET;
  if (!ragUrl || !secret) {
    // Missing config must NOT silently drop the event — queue it so the
    // rag-sync-retry cron redelivers once config is restored (#1595).
    console.error("[rag-sync] RAG_SERVICE_URL or RAG_WEBHOOK_SECRET not set — queuing platform event for retry");
    await queuePendingPlatformSync(toPublish, "RAG_SERVICE_URL or RAG_WEBHOOK_SECRET not set");
    return;
  }

  const url = `${ragUrl.replace(/\/+$/, "")}/api/platform-settings-events`;
  const body = JSON.stringify(toPublish);
  const signature = await hmacHexSign(secret, body);

  let lastError: string | undefined;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      await attemptPost(url, body, signature);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined && attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(delay);
      }
    }
  }

  await queuePendingPlatformSync(toPublish, lastError);
}

// Helper: compute the source_revision for a platform_settings change. Uses
// the highest updated_at across the changed rows so receivers can compare
// numerically. Caller passes the updated rows it just read back from the
// database (the auto-updated_at trigger guarantees a fresh value).
export function sourceRevisionFromUpdatedAt(updatedAt: string | Date): number {
  const d = typeof updatedAt === "string" ? new Date(updatedAt) : updatedAt;
  return Math.floor(d.getTime() / 1000);
}

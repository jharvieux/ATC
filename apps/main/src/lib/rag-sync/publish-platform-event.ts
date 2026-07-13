// D-041 follow-up — Enqueue platform_settings change events for the RAG service.
//
// Mirrors publish-tenant-event.ts (§8.7). #1609: delivery moved onto Inngest —
// this filters to sync-eligible keys and enqueues; rag-sync-deliver performs the
// signed POST with Inngest-managed retries. The originating admin handler is not
// blocked on RAG sync.

import "server-only";

import { type PlatformEvent, type PlatformEventType, type PlatformSettingsEventPayload } from "@atc/contracts";
import { enqueueRagSyncDelivery } from "./enqueue";

export type { PlatformEvent, PlatformEventType, PlatformSettingsEventPayload };

// Keys that the rag side actually consumes. Sending anything else is a
// privacy / surface-area concern (e.g. supervisor_slur_deny_list contains
// raw slurs we don't want to leak across project boundaries). The publish
// function silently filters non-allowed keys; if the resulting payload is
// empty, no event is enqueued.
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

export async function publishPlatformEvent(event: PlatformEvent): Promise<void> {
  // Filter to keys the rag side actually consumes. See SYNC_ELIGIBLE_KEYS.
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

  await enqueueRagSyncDelivery({
    id: `rag-sync:platform:${toPublish.event_type}:${toPublish.source_revision}:${filtered
      .map((c) => c.key)
      .sort()
      .join(",")}`,
    name: "rag-sync/platform.event",
    data: { event: toPublish },
  });
}

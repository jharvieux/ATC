// §8.7 (#1609) — Shared best-effort enqueue for RAG-sync delivery events.
//
// Both publishers (tenant + platform) call this. Delivery itself runs in the
// rag-sync-deliver Inngest function; this only hands the event to Inngest.
//
// Never throws: the caller is a committed lifecycle write (tenant activation,
// signup completion, platform_settings change) that must NOT roll back if
// Inngest is briefly unreachable. An enqueue failure is alerted (not silently
// dropped) and the nightly reconcile (§8.3) heals the resulting drift.

import "server-only";

import { inngest } from "@/inngest/client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import type { TenantEvent, PlatformEvent } from "@atc/contracts";

type RagSyncSend =
  | { id: string; name: "rag-sync/tenant.event"; data: { event: TenantEvent } }
  | { id: string; name: "rag-sync/platform.event"; data: { event: PlatformEvent } };

export async function enqueueRagSyncDelivery(send: RagSyncSend): Promise<void> {
  try {
    await inngest.send(send);
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    await sendOperatorAlert({
      severity: "high",
      signal: "rag_sync_enqueue_failed",
      detail:
        `Failed to enqueue ${send.name} to Inngest. The lifecycle write already ` +
        `committed; nightly reconcile (§8.3) will heal RAG shadow drift.`,
      payload: { event_name: send.name, event_id: send.id, last_error: lastError },
    }).catch((alertErr) => {
      console.error("[rag-sync] enqueue failed AND operator alert failed", {
        event_id: send.id,
        enqueue_error: lastError,
        alert_error: alertErr instanceof Error ? alertErr.message : String(alertErr),
      });
    });
  }
}

// §8.7 — Enqueue tenant lifecycle events for delivery to the RAG service.
//
// #1609: delivery moved off the in-request 3x backoff sleeps + pending_rag_sync
// cron onto Inngest. This just enqueues and returns; rag-sync-deliver performs
// the signed POST with Inngest-managed retries. The originating handler is not
// blocked on RAG sync.
//
// The event id makes a double-enqueue idempotent (Inngest dedups events sharing
// an id within its dedup window); the RAG consumer additionally ignores stale
// source_revisions (§8.7a), so out-of-order/duplicate delivery has one effect.

import "server-only";

import { type TenantEvent, type TenantEventType, type TenantEventPayload } from "@atc/contracts";
import { enqueueRagSyncDelivery } from "./enqueue";

export type { TenantEvent, TenantEventType, TenantEventPayload };

export async function publishTenantEvent(event: TenantEvent): Promise<void> {
  await enqueueRagSyncDelivery({
    id: `rag-sync:tenant:${event.tenant_id}:${event.event_type}:${event.source_revision}`,
    name: "rag-sync/tenant.event",
    data: { event },
  });
}

// §8.7 / §8.7a (#1609) — Inngest-owned delivery of RAG-sync webhooks.
//
// Replaces the in-request 3x backoff sleeps (1s/5s/30s) and the
// pending_rag_sync + rag-sync-retry Vercel cron. Publishers enqueue a
// `rag-sync/tenant.event` or `rag-sync/platform.event` and return immediately;
// this function performs the signed POST with Inngest-managed retries providing
// the backoff ladder §8.7a used to run over the queue table.
//
// Delivery is not ordered, and does not need to be: the RAG consumer ignores
// any event whose source_revision is <= its shadow row's (§8.7a), so retries
// and out-of-order replays are idempotent — one effect regardless of how many
// times an event is delivered. The nightly reconcile (§8.3) remains the durable
// safety net for deliveries that exhaust the retry ladder.
//
// No service-role import: this function only signs and POSTs; it touches no DB.

import { z } from "zod";
import { inngest } from "./client";
import {
  hmacHexSign,
  TenantEventSchema,
  PlatformEventSchema,
  type TenantEvent,
  type PlatformEvent,
} from "@atc/contracts";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

// Matches the §8.7a attempt_count>=10 operator-alert threshold.
const DELIVERY_RETRIES = 10;

async function deliver(path: string, event: TenantEvent | PlatformEvent): Promise<void> {
  const ragUrl = process.env.RAG_SERVICE_URL;
  const secret = process.env.RAG_WEBHOOK_SECRET;
  if (!ragUrl || !secret) {
    // Missing config must not silently drop the event: throw so Inngest keeps
    // retrying until config is restored (reconcile backstops a longer outage).
    throw new Error("RAG_SERVICE_URL or RAG_WEBHOOK_SECRET not set");
  }
  const body = JSON.stringify(event);
  const signature = await hmacHexSign(secret, body);
  const res = await fetch(`${ragUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": signature },
    body,
  });
  if (!res.ok) {
    throw new Error(`RAG ${path} returned ${res.status}`);
  }
}

export const ragSyncDeliver = inngest.createFunction(
  {
    id: "rag-sync-deliver",
    retries: DELIVERY_RETRIES,
    triggers: [
      { event: "rag-sync/tenant.event" },
      { event: "rag-sync/platform.event" },
    ],
  },
  async ({ event, attempt }) => {
    const isTenant = event.name === "rag-sync/tenant.event";
    const path = isTenant ? "/api/tenant-events" : "/api/platform-settings-events";
    // Validate the enqueued envelope before sending (D-091: no raw event.data
    // casts). The publisher builds this, but the contract schema is the guard.
    const { event: rawEvent } = z.object({ event: z.unknown() }).parse(event.data);
    const payload: TenantEvent | PlatformEvent = isTenant
      ? TenantEventSchema.parse(rawEvent)
      : PlatformEventSchema.parse(rawEvent);

    try {
      await deliver(path, payload);
      return { ok: true, attempt };
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err);
      if (attempt >= DELIVERY_RETRIES) {
        // Ladder exhausted (was §8.7a attempt_count>=10). Alert the operator
        // and stop; the nightly reconcile (§8.3) heals the resulting drift.
        await sendOperatorAlert({
          severity: "high",
          signal: "rag_sync_exhausted_retries",
          detail:
            `RAG sync delivery to ${path} exhausted ${DELIVERY_RETRIES} retries. ` +
            `Nightly reconcile will backstop; investigate why the RAG service ` +
            `rejected the event.`,
          payload: {
            path,
            event_type: payload.event_type,
            tenant_id: "tenant_id" in payload ? payload.tenant_id : null,
            source_revision: payload.source_revision,
            last_error: lastError,
          },
        });
        return { failed: true, attempt, last_error: lastError };
      }
      throw err; // let Inngest schedule the next retry per the backoff ladder
    }
  },
);

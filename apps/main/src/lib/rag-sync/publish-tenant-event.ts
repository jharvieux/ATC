// §8.7 — Publish tenant lifecycle events to the RAG service
//
// Retries 3 times with exponential backoff (1s, 5s, 30s) per §8.3.
// On final failure: inserts into pending_rag_sync so the Inngest cron
// can retry. The originating handler is NOT blocked on RAG sync.
//
// Service-role import permitted: publishes to external service after DB write.
// This file is in the no-direct-service-role-import allowlist.

import "server-only";

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { hmacHexSign, type TenantEvent, type TenantEventType, type TenantEventPayload } from "@atc/contracts";

export type { TenantEvent, TenantEventType, TenantEventPayload };

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

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
    throw new Error(`RAG tenant-events returned ${res.status}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Queue an event for the rag-sync-retry cron to redeliver. Shared by the
// missing-config and retries-exhausted paths so neither silently drops.
async function queuePendingRagSync(event: TenantEvent, lastError: string | undefined): Promise<void> {
  console.warn("[rag-sync] queuing tenant event for retry", {
    tenant_id: event.tenant_id,
    event_type: event.event_type,
    last_error: lastError,
  });
  try {
    const db = createServiceRoleClient();
    await safeAwait(db.from("pending_rag_sync").insert({
      tenant_id: event.tenant_id,
      event_type: event.event_type,
      payload: event.payload,
      source_revision: event.source_revision,
      last_error: lastError,
    }), "pending_rag_sync.insert");
  } catch (dbErr) {
    console.error("[rag-sync] Failed to insert into pending_rag_sync:", dbErr);
  }
}

export async function publishTenantEvent(event: TenantEvent): Promise<void> {
  const ragUrl = process.env.RAG_SERVICE_URL;
  const secret = process.env.RAG_WEBHOOK_SECRET;
  if (!ragUrl || !secret) {
    // Missing config must NOT silently drop the event — queue it so the
    // rag-sync-retry cron redelivers once config is restored.
    console.error("[rag-sync] RAG_SERVICE_URL or RAG_WEBHOOK_SECRET not set — queuing for retry");
    await queuePendingRagSync(event, "RAG_SERVICE_URL or RAG_WEBHOOK_SECRET not set");
    return;
  }

  const url = `${ragUrl.replace(/\/+$/, "")}/api/tenant-events`;
  const body = JSON.stringify(event);
  const signature = await hmacHexSign(secret, body);

  let lastError: string | undefined;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      await attemptPost(url, body, signature);
      return; // success
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined && attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(delay);
      }
    }
  }

  // All retries failed — queue for the rag-sync-retry cron.
  await queuePendingRagSync(event, lastError);
}

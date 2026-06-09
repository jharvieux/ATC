// §8.7a — Retry cron for failed RAG tenant-event deliveries
//
// Backoff schedule per §8.7a (attempt_count after failure → next_retry_at delay):
//   0 → 1m,  1 → 5m,  2 → 15m,  3 → 30m,
//   4 → 1h,  5 → 2h,  6+ → 4h (cap)
//
// Service-role import permitted: background job running outside any user
// session. This file is in the no-direct-service-role-import allowlist.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import type { TenantEvent } from "@/lib/rag-sync/publish-tenant-event";
import { inngest } from "./client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { safeAwait } from "@/lib/db/safe-mutation";

// D-041 follow-up — events whose receiver lives at /api/platform-settings-events
// rather than /api/tenant-events. Branch by event-type prefix at delivery time.
const PLATFORM_EVENT_TYPES = new Set<string>(["platform_settings.updated"]);

const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240]; // cap at 4h

function nextBackoffMs(attemptCount: number): number {
  const idx = Math.min(attemptCount, BACKOFF_MINUTES.length - 1);
  return (BACKOFF_MINUTES[idx] ?? 240) * 60 * 1000;
}

export const ragSyncRetry = inngest.createFunction(
  // 15-min cadence (#894 Inngest cost): the 1- and 5-min backoff tiers
  // effectively become ~15 min; later tiers (15/30/60/...) are unaffected.
  { id: "rag-sync-retry", triggers: [{ cron: "*/15 * * * *" }] },
  async () => {
    const db = createServiceRoleClient();

    const { data: rows, error } = await db
      .from("pending_rag_sync")
      .select("id, tenant_id, event_type, payload, source_revision, attempt_count")
      .is("delivered_at", null)
      .lte("next_retry_at", new Date().toISOString())
      .order("next_retry_at", { ascending: true })
      .limit(50);

    if (error) {
      console.error("[rag-sync-retry] query failed:", error.message);
      throw error;
    }

    if (!rows || rows.length === 0) return { retried: 0 };

    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const ragUrl = process.env.RAG_SERVICE_URL;
        const secret = process.env.RAG_WEBHOOK_SECRET;
        if (!ragUrl || !secret) throw new Error("RAG env vars not set");

        const isPlatformEvent = PLATFORM_EVENT_TYPES.has(row.event_type);
        const path = isPlatformEvent ? "/api/platform-settings-events" : "/api/tenant-events";

        // Reconstruct the payload-shaped body. Both event families share the
        // same envelope (event_type, source_revision, payload); tenant events
        // additionally carry tenant_id at the top level.
        const event = isPlatformEvent
          ? {
              event_type: row.event_type,
              source_revision: row.source_revision,
              payload: row.payload,
            }
          : ({
              event_type: row.event_type as TenantEvent["event_type"],
              tenant_id: row.tenant_id,
              source_revision: row.source_revision,
              payload: row.payload as TenantEvent["payload"],
            } satisfies TenantEvent);

        const body = JSON.stringify(event);
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw", enc.encode(secret),
          { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
        );
        const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
        const sigHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");

        const res = await fetch(`${ragUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-webhook-signature": sigHex },
          body,
        });

        if (!res.ok) throw new Error(`RAG returned ${res.status}`);

        await safeAwait(db.from("pending_rag_sync")
          .update({ delivered_at: new Date().toISOString() })
          .eq("id", row.id), "pending_rag_sync.update");

        succeeded++;
      } catch (err) {
        const lastError = err instanceof Error ? err.message : String(err);
        const newCount = (row.attempt_count as number) + 1;
        const nextRetryAt = new Date(Date.now() + nextBackoffMs(newCount)).toISOString();

        await safeAwait(db.from("pending_rag_sync").update({
          attempt_count: newCount,
          next_retry_at: nextRetryAt,
          last_attempt_at: new Date().toISOString(),
          last_error: lastError,
        }).eq("id", row.id), "pending_rag_sync.update");

        if (newCount >= 10) {
          await sendOperatorAlert({
            severity: "high",
            signal: "rag_sync_exhausted_retries",
            detail:
              `pending_rag_sync row ${row.id} exceeded 10 retry attempts. ` +
              `Manual intervention needed — investigate why the rag service ` +
              `rejected this event.`,
            payload: {
              pending_rag_sync_id: row.id,
              tenant_id: row.tenant_id,
              event_type: row.event_type,
              last_error: lastError,
              attempt_count: newCount,
            },
          });
        }

        failed++;
      }
    }

    return { retried: rows.length, succeeded, failed };
  },
);

export const ragSyncCleanup = inngest.createFunction(
  { id: "pending-rag-sync-cleanup", triggers: [{ cron: "0 4 * * *" }] },
  async () => {
    const db = createServiceRoleClient();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error, count } = await db
      .from("pending_rag_sync")
      .delete({ count: "exact" })
      .not("delivered_at", "is", null)
      .lt("delivered_at", cutoff);

    if (error) {
      console.error("[rag-sync-cleanup] delete failed:", error.message);
      throw error;
    }

    console.log("[rag-sync-cleanup] deleted", count, "rows");
    return { deleted: count };
  },
);

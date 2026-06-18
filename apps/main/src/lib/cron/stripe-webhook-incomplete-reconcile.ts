// §7.9a — Stripe webhook incomplete-event reconciliation core logic.
// Runs every 15 minutes via Vercel cron (/api/cron/stripe-webhook-incomplete-reconcile).
// Finds stripe_webhook_events rows where processing started but never completed
// (processing_started_at > stale threshold ago, processing_completed_at IS NULL).
// Alerts + clears the stalled rows so a Stripe re-delivery can reprocess.
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { STALE_WEBHOOK_PROCESSING_MS } from "@/lib/stripe/webhook-constants";

export async function runStripeWebhookIncompleteReconcile() {
  const db = createServiceRoleClient();

  const { data: stalled, error } = await db
    .from("stripe_webhook_events")
    .select("id, stripe_event_id, event_type, processing_started_at")
    .lt(
      "processing_started_at",
      new Date(Date.now() - STALE_WEBHOOK_PROCESSING_MS).toISOString(),
    )
    .is("processing_completed_at", null);

  if (error) {
    console.error("[reconcile] DB query failed:", error.message);
    throw error;
  }

  if (!stalled || stalled.length === 0) {
    console.log("[reconcile] No stalled webhook events found.");
    return { stalled: 0 };
  }

  // One alert per cron run (batched detail) — a sustained Stripe outage
  // would otherwise spam the channel with one ping per stalled event.
  await sendOperatorAlert({
    severity: "high",
    signal: "stripe_webhook_stalled",
    detail:
      `${stalled.length} Stripe webhook event(s) stalled past the processing timeout. ` +
      `Investigate apps/main/src/lib/stripe/webhook-handler.ts and the failing event_types.`,
    payload: {
      stalled_count: stalled.length,
      sample_event_ids: stalled.slice(0, 10).map((r) => r.stripe_event_id),
      sample_event_types: Array.from(new Set(stalled.slice(0, 10).map((r) => r.event_type))),
    },
  });

  // [review gap-fill for #719] Clear stalled rows: stops the table filling with
  // zombie dedup rows, and lets a Stripe re-delivery re-insert + reprocess.
  const staleIds = stalled.map((r) => r.id);
  const { error: deleteErr } = await db
    .from("stripe_webhook_events")
    .delete()
    .in("id", staleIds);
  if (deleteErr) {
    console.error("[reconcile] Failed to clear stalled rows:", deleteErr.message);
    throw deleteErr;
  }

  return { stalled: stalled.length, cleared: staleIds.length };
}

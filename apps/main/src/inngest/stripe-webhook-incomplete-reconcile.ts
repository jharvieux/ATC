// Spec ref: §7.9a — Stripe webhook incomplete-event reconciliation
//
// Finds stripe_webhook_events rows where processing started but never
// completed (processing_started_at > 5 min ago, processing_completed_at IS NULL).
// These indicate a handler that crashed before updating the row.
// Real escalation (PagerDuty / Slack) deferred — logs for now.
//
// Service-role import permitted here: Inngest jobs run outside any user
// session. This file is in the no-direct-service-role-import allowlist.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "./client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

export const stripeWebhookIncompleteReconcile = inngest.createFunction(
  { id: "stripe-webhook-incomplete-reconcile", triggers: [{ cron: "*/15 * * * *" }] },
  async () => {
    const db = createServiceRoleClient();

    const { data: stalled, error } = await db
      .from("stripe_webhook_events")
      .select("id, stripe_event_id, event_type, processing_started_at")
      .lt(
        "processing_started_at",
        new Date(Date.now() - 5 * 60 * 1000).toISOString(),
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

    return { stalled: stalled.length };
  },
);

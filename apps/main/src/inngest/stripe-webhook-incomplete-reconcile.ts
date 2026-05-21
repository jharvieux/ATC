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

    for (const row of stalled) {
      // TODO(escalation): replace with real alert (PagerDuty / Slack) when alerting infra lands
      console.warn("[reconcile] Stalled webhook event detected", {
        id: row.id,
        stripe_event_id: row.stripe_event_id,
        event_type: row.event_type,
        processing_started_at: row.processing_started_at,
      });
    }

    return { stalled: stalled.length };
  },
);

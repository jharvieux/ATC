// §27.4.4 / §27.6 — Email bounce-rate side channel.
//
// Every 6h: per tenant, compute (bounces ÷ sent) over the rolling 24h.
// If > threshold (default 5%): write abuse_signals row + flip
// tenant_settings.email_paused_due_to_bounce_rate=TRUE. This pause is
// INDEPENDENT of the monthly volume state — it lifts when the rolling
// rate drops back below the threshold.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const emailBounceRateMonitor = inngest.createFunction(
  {
    id: "email-bounce-rate-monitor",
    triggers: [{ cron: "0 */6 * * *" }],
  },
  async () => {
    const svc = createServiceRoleClient();
    if (process.env.STAGING_MODE === "true") {
      await svc.from("staging_cron_skips").insert({ cron_id: "email-bounce-rate-monitor" });
      return { skipped_for_staging: true };
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const threshold = Number(process.env.ABUSE_EMAIL_BOUNCE_RATE_THRESHOLD_PERCENT ?? 5);

    // Per-tenant aggregation by reading email_log + grouping in-process.
    // For large tenants this should be a SQL aggregate; iterate-in-app is
    // fine for v1.
    const { data: rows } = await svc
      .from("email_log")
      .select("tenant_id, status")
      .gte("created_at", since)
      .limit(50000);

    const tally = new Map<string, { sent: number; bounced: number }>();
    for (const r of (rows ?? []) as Array<{ tenant_id: string; status: string }>) {
      const t = tally.get(r.tenant_id) ?? { sent: 0, bounced: 0 };
      if (r.status === "sent" || r.status === "delivered") t.sent++;
      if (r.status === "hard_bounced" || r.status === "soft_bounced") t.bounced++;
      tally.set(r.tenant_id, t);
    }

    let updated = 0;
    for (const [tenant_id, t] of tally.entries()) {
      const total = t.sent + t.bounced;
      if (total < 10) continue; // not enough volume to be meaningful
      const rate = (t.bounced / total) * 100;
      const shouldPause = rate > threshold;

      // Read current pause flag
      const { data: settings } = await svc
        .from("tenant_settings")
        .select("email_paused_due_to_bounce_rate")
        .eq("tenant_id", tenant_id)
        .maybeSingle();
      const currentlyPaused = Boolean((settings as { email_paused_due_to_bounce_rate?: boolean } | null)?.email_paused_due_to_bounce_rate);

      if (shouldPause !== currentlyPaused) {
        await svc
          .from("tenant_settings")
          .upsert({ tenant_id, email_paused_due_to_bounce_rate: shouldPause }, { onConflict: "tenant_id" });
        updated++;
      }
      if (shouldPause) {
        await svc.from("abuse_signals").insert({
          tenant_id,
          signal_kind: "email_bounce_rate",
          detail: { rate_percent: rate, sent: t.sent, bounced: t.bounced, window_hours: 24 },
        });
      }
    }
    return { tenants_seen: tally.size, paused_flag_changes: updated };
  },
);

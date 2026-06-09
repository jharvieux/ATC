// §26.6 — Permission-denied spike monitor.
//
// Every 15 minutes, count audit_log rows where action ends with
// '.permission_denied' in the last 15 minutes, grouped by actor_user_id.
// ≥ 20 per user → medium-severity operator alert.
// (Was 5-min/5-min; stretched per #894 Inngest cost. Threshold kept at 20:
// slow probing now trips sooner, but worst-case detection latency for a fast
// burst grows from ~5 to ~15 min.)

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

const THRESHOLD = 20;

export const permissionDeniedMonitor = inngest.createFunction(
  {
    id: "permission-denied-monitor",
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async () => {
    const svc = createServiceRoleClient();
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const { data } = await svc
      .from("audit_log")
      .select("actor_user_id, action")
      .like("action", "%.permission_denied")
      .gte("occurred_at", since)
      .limit(10000);

    const byUser = new Map<string, number>();
    for (const row of ((data ?? []) as Array<{ actor_user_id: string | null }>)) {
      const u = row.actor_user_id ?? "anonymous";
      byUser.set(u, (byUser.get(u) ?? 0) + 1);
    }
    const offenders = [...byUser.entries()].filter(([, n]) => n >= THRESHOLD);

    for (const [user, count] of offenders) {
      await sendOperatorAlert({
        severity: "medium",
        signal: "permission_denied_spike",
        detail: `${count} permission-denied events from user ${user} in the last 15 minutes`,
        payload: { actor_user_id: user, count, window_minutes: 15 },
      });
    }
    return { offenders_count: offenders.length };
  },
);

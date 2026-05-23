// §26.6 — Auth failure spike monitor.
//
// Every 5 minutes, count auth failures per IP in the last 5 minutes.
// Any IP with ≥ 50 failures → medium-severity operator alert.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

const THRESHOLD = 50;

export const authFailureMonitor = inngest.createFunction(
  {
    id: "auth-failure-monitor",
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async () => {
    const svc = createServiceRoleClient();
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data } = await svc
      .from("auth_attempts")
      .select("ip")
      .eq("outcome", "failure")
      .gte("occurred_at", since)
      .limit(10000);

    const byIp = new Map<string, number>();
    for (const row of ((data ?? []) as Array<{ ip: string }>)) {
      byIp.set(row.ip, (byIp.get(row.ip) ?? 0) + 1);
    }
    const offenders = [...byIp.entries()].filter(([, n]) => n >= THRESHOLD);

    for (const [ip, count] of offenders) {
      await sendOperatorAlert({
        severity: "medium",
        signal: "auth_failure_spike",
        detail: `${count} auth failures from ${ip} in the last 5 minutes`,
        payload: { ip, count, window_minutes: 5 },
      });
    }
    return { offenders_count: offenders.length };
  },
);

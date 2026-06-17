// §26.6 — Auth failure spike monitor core logic.
// Runs every 5 minutes via Vercel cron (/api/cron/auth-failure-monitor).
// Counts auth failures per IP in the last 5 minutes; any IP with ≥ 50
// failures fires a medium-severity operator alert.
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

const THRESHOLD = 50;
const WINDOW_MINUTES = 5;

export async function runAuthFailureMonitor() {
  const svc = createServiceRoleClient();
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

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
      detail: `${count} auth failures from ${ip} in the last ${WINDOW_MINUTES} minutes`,
      payload: { ip, count, window_minutes: WINDOW_MINUTES },
    });
  }
  return { offenders_count: offenders.length };
}

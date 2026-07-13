// §26.6 — Permission-denied spike monitor core logic.
// Runs every 5 minutes via Vercel cron (/api/cron/permission-denied-monitor).
// Counts audit_log rows where action ends with '.permission_denied' in the
// last 5 minutes, grouped by actor_user_id. ≥ 20 per user fires a
// medium-severity operator alert.
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import "server-only";

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

const THRESHOLD = 20;
const WINDOW_MINUTES = 5;
// #1789 — one alert per offending user, each independent; bounded concurrency
// so a multi-user spike doesn't serialize N Resend round-trips.
const ALERT_CONCURRENCY = 10;

export async function runPermissionDeniedMonitor() {
  const svc = createServiceRoleClient();
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await svc
    .from("audit_log")
    .select("actor_user_id, action")
    .like("action", "%.permission_denied")
    .gte("occurred_at", since)
    .limit(10000);
  if (error) throw new Error(`audit_log select failed: ${error.message}`);

  const byUser = new Map<string, number>();
  for (const row of ((data ?? []) as Array<{ actor_user_id: string | null }>)) {
    const u = row.actor_user_id ?? "anonymous";
    byUser.set(u, (byUser.get(u) ?? 0) + 1);
  }
  const offenders = [...byUser.entries()].filter(([, n]) => n >= THRESHOLD);

  await mapWithConcurrency(offenders, ALERT_CONCURRENCY, ([user, count]) =>
    sendOperatorAlert({
      severity: "medium",
      signal: "permission_denied_spike",
      detail: `${count} permission-denied events from user ${user} in the last ${WINDOW_MINUTES} minutes`,
      payload: { actor_user_id: user, count, window_minutes: WINDOW_MINUTES },
    }),
  );
  return { offenders_count: offenders.length };
}

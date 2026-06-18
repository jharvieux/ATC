// §26.6 — Cross-tenant RLS bypass attempt monitor. Runs every 15 minutes via
// Vercel cron (/api/cron/cross-tenant-rls-bypass-monitor).
//
// Scan audit_log for rows where the RLS error handler has recorded a structured
// `rls_bypass_attempt: true` indicator in changes. Any single hit is
// critical-severity (immediate alert).
//
// Per §26.13: this monitor runs on staging too (real PII risk acceptance).
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

export async function runCrossTenantRlsBypassMonitor(): Promise<{ detected: number }> {
  const svc = createServiceRoleClient();
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // GIN partial index makes this lookup cheap for admin rows; for system
  // rows we don't have an index, accept the seq scan over the last 15
  // minutes — small window keeps it bounded.
  const { data } = await svc
    .from("audit_log")
    .select("id, tenant_id, actor_user_id, changes, occurred_at")
    .eq("actor_type", "system")
    .filter("changes->>rls_bypass_attempt", "eq", "true")
    .gte("occurred_at", since)
    .limit(100);

  const rows = (data ?? []) as Array<{ id: string; tenant_id: string | null }>;
  for (const row of rows) {
    await sendOperatorAlert({
      severity: "critical",
      signal: "cross_tenant_rls_bypass_attempt",
      detail: `RLS bypass attempt detected (audit_log id ${row.id})`,
      payload: { audit_log_id: row.id, tenant_id: row.tenant_id },
    });
  }
  return { detected: rows.length };
}

// §13.5.4 — Credential health check for the tenant-facing degraded-mode banner.
//
// Returns the status of all host adapter credentials for a tenant.
// Used by the dashboard banner to show: "Your credentials cannot be loaded."
//
// Health is determined by:
//   - credential_status = 'rejected' | 'expired' | 'revoked' → degraded
//   - audit_log entry with action='credential.decryption_failed' in the
//     last 24 hours → degraded (even if status row still says 'active')

import "server-only";

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export interface CredentialHealth {
  status: "healthy" | "degraded";
  affected_adapters: string[];
  banner_message?: string;
}

const RECENT_DECRYPTION_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getTenantCredentialHealth(
  tenant_id: string,
): Promise<CredentialHealth> {
  const db = createServiceRoleClient();

  const { data, error } = await db
    .from("tenant_host_configs")
    .select("adapter_id, credential_status")
    .eq("tenant_id", tenant_id)
    .eq("is_active", true);

  if (error || !data || data.length === 0) {
    return { status: "healthy", affected_adapters: [] };
  }

  type ConfigRow = { adapter_id: string; credential_status: string };
  const degradedStatuses = new Set(["rejected", "expired", "revoked"]);
  const statusAffected = new Set(
    (data as ConfigRow[])
      .filter((r) => degradedStatuses.has(r.credential_status))
      .map((r) => r.adapter_id),
  );

  const since = new Date(Date.now() - RECENT_DECRYPTION_FAILURE_WINDOW_MS).toISOString();
  const { data: auditRows } = await db
    .from("audit_log")
    .select("changes")
    .eq("tenant_id", tenant_id)
    .eq("action", "credential.decryption_failed")
    .gte("created_at", since);

  for (const row of (auditRows ?? []) as Array<{ changes: { adapter_id?: string } | null }>) {
    const adapter_id = row.changes?.adapter_id;
    if (typeof adapter_id === "string") statusAffected.add(adapter_id);
  }

  if (statusAffected.size === 0) {
    return { status: "healthy", affected_adapters: [] };
  }

  return {
    status: "degraded",
    affected_adapters: Array.from(statusAffected),
    banner_message:
      `Your host adapter credentials cannot be loaded. ` +
      `Please re-enter them in Settings to resume bookings.`,
  };
}

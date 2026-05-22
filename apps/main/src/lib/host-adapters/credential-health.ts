// §13.5.4 — Credential health check for the tenant-facing degraded-mode banner.
//
// Returns the status of all host adapter credentials for a tenant.
// Used by the dashboard banner to show: "Your credentials cannot be loaded."
//
// Health is determined by:
//   - credential_status = 'rejected' | 'expired' | 'revoked' → degraded
//   - recent audit_log entry with action = 'credential.decryption_failed' → degraded
//
// TODO(audit-log §26): the audit_log join below is stubbed until the table lands.

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export interface CredentialHealth {
  status: "healthy" | "degraded";
  affected_adapters: string[];
  banner_message?: string;
}

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
  const affected = (data as ConfigRow[])
    .filter((r) => degradedStatuses.has(r.credential_status))
    .map((r) => r.adapter_id);

  if (affected.length === 0) {
    return { status: "healthy", affected_adapters: [] };
  }

  return {
    status: "degraded",
    affected_adapters: affected,
    banner_message:
      `Your host adapter credentials cannot be loaded. ` +
      `Please re-enter them in Settings to resume bookings.`,
  };
}

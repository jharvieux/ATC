// §13.7 — Adapter selection flow.
//
// Priority (top wins):
//   1. Tenant has a verified host config → use that adapter + decrypt credentials.
//   2. Tenant is sub-host → use platform default + sub-host credentials (§13.8).
//   3. Tenant is platform (Prong 1) → use platform default.
//   4. BYO-host with no config → fallback email adapter.
//
// CRITICAL per §13.5.3: if credential decryption fails, return a degraded adapter
// that always returns auth_failed. Do NOT silently fall back to the email adapter —
// that would mask a security incident.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { decryptCredential } from "@/lib/crypto/credential-cipher";
import { getAdapter, getPlatformDefaultAdapter } from "./registry";
import FallbackEmailAdapter from "./fallback-email/adapter";
import type { HostAgencyClient, HostCapabilities, HostCallContext, HostAdapterError, Result } from "@atc/shared-types";
import { Err } from "@atc/shared-types";

export interface TenantForAdapterSelection {
  id: string;
  prong: "platform" | "sub_host" | "byo_host" | string;
}

type HostConfigRow = {
  adapter_id: string;
  credentials: { ciphertext: string; key_id: string };
  credential_status: string;
};

function makeCredentialFailedAdapter(adapterDisplayName: string): HostAgencyClient {
  const err: Result<never, HostAdapterError> = Err({
    code: "auth_failed",
    message:
      `Credentials need to be re-entered — please visit Settings > Host Integration. ` +
      `Adapter: ${adapterDisplayName}`,
  });

  const caps: HostCapabilities = {
    supports_inventory_search: false,
    supports_real_time_booking: false,
    supports_modification: false,
    supports_cancellation: false,
    supports_commission_api: false,
    booking_types: [],
    cruise_lines_supported: [],
    commission_currency: "USD",
    payment_lag_days_typical: 0,
  };

  return {
    adapterId: "credential-failed",
    displayName: adapterDisplayName,
    capabilities: caps,
    describeCapabilities: () => caps,
    searchInventory: async () => err,
    submitBooking: async () => err,
    fetchBookingStatus: async () => err,
    cancelBooking: async () => err,
    modifyBooking: async () => err,
    fetchCommissionStatement: async () => err,
    recordCommissionPayment: async () => err,
    healthCheck: async () => ({
      ok: false,
      message: "Credential decryption failed. Credentials must be re-entered.",
    }),
  };
}

export async function selectAdapter(
  tenant: TenantForAdapterSelection,
): Promise<HostAgencyClient> {
  const db = createServiceRoleClient();

  // Step 1: tenant has a verified host config
  const { data: configData } = await db
    .from("tenant_host_configs")
    .select("adapter_id, credentials, credential_status")
    .eq("tenant_id", tenant.id)
    .eq("credential_status", "verified")
    .eq("is_active", true)
    .maybeSingle();

  if (configData) {
    const row = configData as HostConfigRow;
    const decrypted = decryptCredential(row.credentials);
    if (!decrypted.ok) {
      // §13.5.3 / §13.5.4: do NOT fall back — return degraded adapter
      const adapterName = row.adapter_id;
      return makeCredentialFailedAdapter(adapterName);
    }
    return getAdapter(row.adapter_id);
  }

  // Step 2: sub-host → platform default + sub-host credentials
  if (tenant.prong === "sub_host") {
    return getPlatformDefaultAdapter();
  }

  // Step 3: platform (Prong 1)
  if (tenant.prong === "platform") {
    return getPlatformDefaultAdapter();
  }

  // Step 4: BYO-host with no config
  return new FallbackEmailAdapter();
}

// Convenience: same flow but returns the ctx-carrying version of select
export async function selectAdapterForCall(
  tenant: TenantForAdapterSelection,
  _ctx: HostCallContext,
): Promise<HostAgencyClient> {
  return selectAdapter(tenant);
}

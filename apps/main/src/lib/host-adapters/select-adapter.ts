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
    supports_price_lock: false,
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

// Internal: select adapter + return decrypted credentials separately so the
// caller can either build a ctx or just use the adapter (the old behavior).
async function selectAdapterAndCredentials(
  tenant: TenantForAdapterSelection,
): Promise<{ adapter: HostAgencyClient; credentials: Record<string, unknown> | null }> {
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
      return { adapter: makeCredentialFailedAdapter(row.adapter_id), credentials: null };
    }
    // Coerce to a generic record. Adapter implementations cast/validate.
    const credentials =
      typeof decrypted.value === "object" && decrypted.value !== null
        ? (decrypted.value as Record<string, unknown>)
        : { value: decrypted.value };
    return { adapter: await getAdapter(row.adapter_id), credentials };
  }

  // Step 2: sub-host → platform default + sub-host credentials
  if (tenant.prong === "sub_host") {
    return { adapter: await getPlatformDefaultAdapter(), credentials: null };
  }

  // Step 3: platform (Prong 1)
  if (tenant.prong === "platform") {
    return { adapter: await getPlatformDefaultAdapter(), credentials: null };
  }

  // Step 4: BYO-host with no config
  return { adapter: new FallbackEmailAdapter(), credentials: null };
}

/**
 * Picks the adapter for this tenant. Credentials are NOT included in the
 * returned instance state — call `selectAdapterForCall` instead when you
 * need to invoke methods on the adapter, so the call-time context carries
 * the right per-tenant credentials.
 *
 * Keep this overload for places that only inspect `capabilities` or call
 * `healthCheck()` (which by contract does not require credentials).
 */
export async function selectAdapter(
  tenant: TenantForAdapterSelection,
): Promise<HostAgencyClient> {
  return (await selectAdapterAndCredentials(tenant)).adapter;
}

/**
 * Picks the adapter AND builds the HostCallContext to invoke its methods
 * with. The returned `ctx` carries the decrypted per-tenant credentials
 * when applicable. Use this whenever you intend to actually call
 * `searchInventory`, `submitBooking`, etc.
 *
 * Audit pass 2, Finding 8: previously credentials were decrypted and
 * silently discarded; the singleton adapter ran with platform-default
 * credentials for every tenant. Callers MUST migrate to this form.
 */
export async function selectAdapterForCall(
  tenant: TenantForAdapterSelection,
  baseCtx: HostCallContext,
): Promise<{ adapter: HostAgencyClient; ctx: HostCallContext }> {
  const { adapter, credentials } = await selectAdapterAndCredentials(tenant);
  const ctx: HostCallContext = credentials
    ? { ...baseCtx, credentials }
    : baseCtx;
  return { adapter, ctx };
}

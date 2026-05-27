// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// §13.3 — Adapter registry: loads and lists HostAgencyClient instances.
//
// Adapter instances are constructed fresh per call. Node's module cache
// handles the cost of `await import(...)`; constructor cost is negligible
// for the adapters we ship.
//
// PRIOR DESIGN (removed 2026-05-25):
//   A `Map<adapter_id, instance>` cache held a singleton per adapter.
//   Audit pass 2 (Finding 8) showed that the singleton shared state
//   across tenants — if any adapter implementation kept mutable state
//   (commission session tokens, retry counters), tenant A's call could
//   observe tenant B's state. Dropped the cache; adapters now MUST be
//   stateless and read per-tenant credentials from HostCallContext at
//   call time.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import type { HostAgencyClient } from "@atc/shared-types";

type AdapterRow = {
  adapter_id: string;
  display_name: string;
  implementation_path: string;
  config: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  is_active: boolean;
  is_default: boolean;
};

export async function getAdapter(adapter_id: string): Promise<HostAgencyClient> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("host_adapters")
    .select("adapter_id, display_name, implementation_path, config, capabilities, is_active, is_default")
    .eq("adapter_id", adapter_id)
    .eq("is_active", true)
    .single();

  if (error || !data) {
    throw new Error(`Host adapter '${adapter_id}' not found or inactive.`);
  }

  const row = data as AdapterRow;

  // Audit pass 2, Finding 9: whitelist `implementation_path` before
  // `await import(...)`. Today `host_adapters` is service-role-only-writable,
  // so the path is platform-controlled. Latent RCE if a future "custom
  // adapter" feature or SQL-injection ever lets a tenant influence this
  // column. Whitelist the shape we actually ship: `@/lib/host-adapters/<slug>/adapter`.
  const ALLOWED_IMPLEMENTATION_PATH = /^@\/lib\/host-adapters\/[a-z0-9][a-z0-9-]*\/adapter$/;
  if (!ALLOWED_IMPLEMENTATION_PATH.test(row.implementation_path)) {
    throw new Error(
      `Host adapter '${adapter_id}' has implementation_path='${row.implementation_path}' ` +
        `which does not match the allowed pattern. Refusing to dynamic-import.`,
    );
  }

  const mod = await import(/* @vite-ignore */ row.implementation_path);
  const firstKey = Object.keys(mod)[0];
  const AdapterClass = mod.default ?? (firstKey !== undefined ? mod[firstKey] : undefined);

  if (typeof AdapterClass !== "function") {
    throw new Error(
      `Adapter module '${row.implementation_path}' does not export a default class or constructor.`,
    );
  }

  // Constructor receives the PLATFORM config (the adapter row's `config`
  // column), which carries non-secret defaults (endpoints, timeouts).
  // PER-TENANT credentials are NOT passed at construction time — adapters
  // read them from HostCallContext.credentials at call time.
  return new AdapterClass(row.config) as HostAgencyClient;
}

export async function listActiveAdapters(): Promise<AdapterRow[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("host_adapters")
    .select("adapter_id, display_name, implementation_path, config, capabilities, is_active, is_default")
    .eq("is_active", true)
    .order("display_name");

  if (error) {
    throw new Error(`Failed to list active adapters: ${error.message}`);
  }

  return (data ?? []) as AdapterRow[];
}

export async function getPlatformDefaultAdapter(): Promise<HostAgencyClient> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("host_adapters")
    .select("adapter_id")
    .eq("is_default", true)
    .eq("is_active", true)
    .single();

  if (error || !data) {
    // Final fallback: always-available email adapter
    return getAdapter("fallback-email");
  }

  return getAdapter((data as { adapter_id: string }).adapter_id);
}

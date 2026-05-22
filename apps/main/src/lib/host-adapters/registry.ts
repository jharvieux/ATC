// §13.3 — Adapter registry: loads, caches, and lists HostAgencyClient instances.
//
// Adapter instances are stateless after construction; the cache avoids
// re-importing and re-constructing on every request.

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

const adapterCache = new Map<string, HostAgencyClient>();

export async function getAdapter(adapter_id: string): Promise<HostAgencyClient> {
  if (adapterCache.has(adapter_id)) {
    return adapterCache.get(adapter_id)!;
  }

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
  const mod = await import(/* @vite-ignore */ row.implementation_path);
  const firstKey = Object.keys(mod)[0];
  const AdapterClass = mod.default ?? (firstKey !== undefined ? mod[firstKey] : undefined);

  if (typeof AdapterClass !== "function") {
    throw new Error(
      `Adapter module '${row.implementation_path}' does not export a default class or constructor.`,
    );
  }

  const instance = new AdapterClass(row.config) as HostAgencyClient;
  adapterCache.set(adapter_id, instance);
  return instance;
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

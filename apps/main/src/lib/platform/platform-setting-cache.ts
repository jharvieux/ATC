// #1586 — Cross-request TTL cache for `platform_settings` value lookups.
//
// `platform_settings` is a GLOBAL (not tenant-scoped) key→value store whose
// rows change weekly-to-never: the AI kill switch, the slur deny list, the
// bug-intent phrase list, the soft-tier persona prompts. The chat hot path was
// reading 3-4 of these per message, uncached, adding serial DB latency before
// the first token. A 30-60s propagation delay on these is acceptable (the
// kill switch already races in-flight streams today — see #1586).
//
// The reader mirrors the supabase `{ data, error }` shape via `{ value, error }`
// so each caller keeps its own error semantics (load-deny-list fails CLOSED and
// throws; the kill-switch read fails OPEN and treats an error as "not engaged").
// We only cache on SUCCESS — a read error is never cached, so the next call
// retries the DB instead of pinning a bad value for a full TTL.

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

const TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface CachedPlatformSetting {
  value: unknown;
  error: PostgrestError | null;
}

/**
 * Read a `platform_settings.value` by key, served from a 60s in-process cache.
 * `onDbRead` (optional) fires only on a cache MISS that hits the DB — used by
 * the chat route to count real config round-trips for the #1586 perf log.
 */
export async function getCachedPlatformSetting(
  db: SupabaseClient,
  key: string,
  onDbRead?: () => void,
): Promise<CachedPlatformSetting> {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return { value: hit.value, error: null };

  onDbRead?.();
  const { data, error } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) return { value: null, error };

  const value = (data as { value?: unknown } | null)?.value ?? null;
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return { value, error: null };
}

/** Test-only: clear the cache between specs. */
export function _resetPlatformSettingCacheForTests(): void {
  cache.clear();
}

/** Evict a single key — call after an operator edits it so the next read is fresh. */
export function evictPlatformSetting(key: string): void {
  cache.delete(key);
}

// §20.7 — Resolve the platform host-agency legal name from a raw
// `platform_settings.value`. The value ships as either a bare string or a JSON
// object with a nested `.value` — both shapes are in the wild on dev.
//
// Fail-closed (#1856/#1878 semantics): returns null on a missing or malformed
// value — NEVER a placeholder. Every caller that renders the §20.7
// tenant-of-record disclosure must treat null as "disclosure unavailable" and
// fail closed, never substitute a fabricated legal name into a customer-facing
// document. This is the single canonical unwrap: #1877 collapsed the three
// copy-paste variants (build-render-input, quotes/accept, tenant-of-record)
// plus the divergent quote-stripping reader onto it.
export function resolveHostAgencyLegalName(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) {
    const value = (raw as { value?: unknown }).value;
    return typeof value === "string" ? value : null;
  }
  return null;
}

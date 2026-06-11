// §26.9 — Vendor health registry.
//
// Dual-layer:
//   1. In-process cache: avoids a DB round-trip on every gated call.
//      Cache TTL = CACHE_TTL_MS (30 s). Probe writes invalidate it.
//   2. Durable store: `vendor_health` Supabase table. The probe upserts
//      there; the admin page reads from there for cross-instance consistency.
//
// Transition semantics: status changes (healthy→degraded, degraded→down,
// any→healthy) are computed against the DURABLE prior state, not the
// per-instance cache, so only one instance fires the alert per event.

export type VendorName = "anthropic" | "openai" | "stripe" | "resend" | "supabase" | "inngest" | "upstash" | "rag" | "supabase_rag";

export type VendorHealthStatus = "healthy" | "degraded" | "down";

export interface VendorHealthState {
  status: VendorHealthStatus;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_error: string | null;
  status_changed_at?: string | null;
}

export const DEGRADE_AFTER_FAILURES = 3;
export const DOWN_AFTER_FAILURES = 5;

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  state: VendorHealthState;
  expires_at: number;
}

const cache = new Map<VendorName, CacheEntry>();

export function computeStatus(consecutive_failures: number): VendorHealthStatus {
  if (consecutive_failures >= DOWN_AFTER_FAILURES) return "down";
  if (consecutive_failures >= DEGRADE_AFTER_FAILURES) return "degraded";
  return "healthy";
}

// ---------------------------------------------------------------------------
// In-process cache helpers (used by gate.ts for fast reads)
// ---------------------------------------------------------------------------

function cacheGet(name: VendorName): VendorHealthState | null {
  const entry = cache.get(name);
  if (!entry || Date.now() > entry.expires_at) return null;
  return entry.state;
}

function cacheSet(name: VendorName, state: VendorHealthState): void {
  cache.set(name, { state, expires_at: Date.now() + CACHE_TTL_MS });
}

export function vendorHealthStatus(name: VendorName): VendorHealthStatus {
  return cacheGet(name)?.status ?? "healthy";
}

// ---------------------------------------------------------------------------
// Legacy in-memory only path (used when no DB client is available, e.g. tests)
// ---------------------------------------------------------------------------

const memRegistry = new Map<VendorName, VendorHealthState>();

function memEnsure(name: VendorName): VendorHealthState {
  let state = memRegistry.get(name);
  if (!state) {
    state = { status: "healthy", consecutive_failures: 0, last_checked_at: null, last_error: null };
    memRegistry.set(name, state);
  }
  return state;
}

export function recordVendorSuccess(name: VendorName): void {
  const state = memEnsure(name);
  state.status = "healthy";
  state.consecutive_failures = 0;
  state.last_checked_at = new Date().toISOString();
  state.last_error = null;
  cacheSet(name, { ...state });
}

export function recordVendorFailure(name: VendorName, error: string): void {
  const state = memEnsure(name);
  state.consecutive_failures += 1;
  state.last_checked_at = new Date().toISOString();
  state.last_error = error;
  state.status = computeStatus(state.consecutive_failures);
  cacheSet(name, { ...state });
}

export function snapshotVendorHealth(): Record<VendorName, VendorHealthState> {
  const out = {} as Record<VendorName, VendorHealthState>;
  for (const name of ["anthropic", "openai", "stripe", "resend", "supabase", "inngest", "upstash", "rag", "supabase_rag"] as VendorName[]) {
    out[name] = { ...memEnsure(name) };
  }
  return out;
}

// Test-only: reset all state.
export function _resetVendorHealthForTests(): void {
  memRegistry.clear();
  cache.clear();
}

// ---------------------------------------------------------------------------
// Durable upsert — called by the probe after each ping.
// Returns the PRIOR durable status so the probe can detect transitions.
// ---------------------------------------------------------------------------

export interface UpsertVendorHealthInput {
  vendor: VendorName;
  success: boolean;
  error_message?: string | null;
  db: import("@supabase/supabase-js").SupabaseClient;
}

export interface UpsertVendorHealthResult {
  prior_status: VendorHealthStatus;
  new_status: VendorHealthStatus;
  transitioned: boolean;
}

export async function upsertVendorHealth(
  input: UpsertVendorHealthInput,
): Promise<UpsertVendorHealthResult> {
  const { vendor, success, error_message, db } = input;
  const now = new Date().toISOString();

  // 1. Read current durable state (may be absent on first run).
  const { data: current } = await db
    .from("vendor_health")
    .select("status, consecutive_failures, status_changed_at")
    .eq("vendor", vendor)
    .maybeSingle();

  const prior_status: VendorHealthStatus = (current?.status as VendorHealthStatus | undefined) ?? "healthy";
  const prior_failures: number = current?.consecutive_failures ?? 0;

  const new_failures = success ? 0 : prior_failures + 1;
  const new_status = success ? "healthy" : computeStatus(new_failures);
  const transitioned = new_status !== prior_status;

  const row = {
    vendor,
    status: new_status,
    consecutive_failures: new_failures,
    last_checked_at: now,
    last_error: success ? null : (error_message ?? null),
    ...(transitioned && { status_changed_at: now }),
  };

  const { error } = await db.from("vendor_health").upsert(row, { onConflict: "vendor" });
  if (error) {
    throw new Error(`[vendor-health] upsert failed for ${vendor}: ${error.message}`);
  }

  // Update in-process cache.
  cacheSet(vendor, {
    status: new_status,
    consecutive_failures: new_failures,
    last_checked_at: now,
    last_error: success ? null : (error_message ?? null),
  });

  return { prior_status, new_status, transitioned };
}

// ---------------------------------------------------------------------------
// Durable list — used by the admin page for cross-instance consistent view.
// ---------------------------------------------------------------------------

export async function listVendorHealth(
  db: import("@supabase/supabase-js").SupabaseClient,
): Promise<Array<VendorHealthState & { vendor: string }>> {
  const { data, error } = await db
    .from("vendor_health")
    .select("vendor, status, consecutive_failures, last_checked_at, last_error, status_changed_at")
    .order("vendor");
  if (error) {
    console.error(`[vendor-health] list failed: ${error.message}`);
    return [];
  }
  return (data ?? []) as Array<VendorHealthState & { vendor: string }>;
}

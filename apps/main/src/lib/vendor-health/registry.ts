// §26.9 — Vendor health registry.
//
// Per-instance in-memory state for each vendor we depend on. The probe
// cron (inngest/vendor-health-probe.ts) updates this every minute; the
// admin page (/admin/vendor-status) reads it; degraded-mode call sites
// check vendorHealthStatus(name) before delegating.
//
// Since this is per-instance (not Redis-backed), each Vercel function
// instance maintains its own view. The probe runs per-instance too; the
// admin page may show slightly different states from different instances
// during a partial outage. Acceptable for §26.9 (we want best-effort
// degraded-mode hooks, not strong consensus).

export type VendorName = "anthropic" | "openai" | "stripe" | "resend" | "supabase";

export type VendorHealthStatus = "healthy" | "degraded" | "down";

export interface VendorHealthState {
  status: VendorHealthStatus;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_error: string | null;
}

const DEGRADE_AFTER_FAILURES = 3;
const DOWN_AFTER_FAILURES = 5;

const registry = new Map<VendorName, VendorHealthState>();

function ensure(name: VendorName): VendorHealthState {
  let state = registry.get(name);
  if (!state) {
    state = {
      status: "healthy",
      consecutive_failures: 0,
      last_checked_at: null,
      last_error: null,
    };
    registry.set(name, state);
  }
  return state;
}

export function recordVendorSuccess(name: VendorName): void {
  const state = ensure(name);
  state.status = "healthy";
  state.consecutive_failures = 0;
  state.last_checked_at = new Date().toISOString();
  state.last_error = null;
}

export function recordVendorFailure(name: VendorName, error: string): void {
  const state = ensure(name);
  state.consecutive_failures += 1;
  state.last_checked_at = new Date().toISOString();
  state.last_error = error;
  if (state.consecutive_failures >= DOWN_AFTER_FAILURES) {
    state.status = "down";
  } else if (state.consecutive_failures >= DEGRADE_AFTER_FAILURES) {
    state.status = "degraded";
  }
}

export function vendorHealthStatus(name: VendorName): VendorHealthStatus {
  return ensure(name).status;
}

export function snapshotVendorHealth(): Record<VendorName, VendorHealthState> {
  const out = {} as Record<VendorName, VendorHealthState>;
  for (const name of ["anthropic", "openai", "stripe", "resend", "supabase"] as VendorName[]) {
    out[name] = { ...ensure(name) };
  }
  return out;
}

// Test-only: reset all state.
export function _resetVendorHealthForTests(): void {
  registry.clear();
}

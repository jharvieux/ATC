// BP34 §34.3.5 — routing decision after validation.
//
// Three things drive routing:
//   1. Validation flags. If ANY flag exists, route to review.
//   2. Tenant's auto-accept threshold (per-tenant override of the
//      platform_setting default).
//   3. Overall extraction confidence vs. the threshold.
//
// Plus an absolute floor: certain document_types are NEVER auto-accepted
// regardless of confidence (commission_statement per §14.8).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ValidationFlag } from "./validation";

const PLATFORM_DEFAULT_KEY = "bp34_import_auto_accept_threshold_default";

const NEVER_AUTO_ACCEPT: ReadonlySet<string> = new Set([
  "commission_statement",
]);

export type RouteDecision = {
  route: "auto_accept" | "review";
  reason: string;
  threshold_used: number;
};

export async function decideRoute(args: {
  tenant_id: string;
  document_type: string;
  overall_confidence: number;
  validation_flags: ValidationFlag[];
  db: Pick<SupabaseClient, "from">;
}): Promise<RouteDecision> {
  const { tenant_id, document_type, overall_confidence, validation_flags, db } = args;

  const threshold = await loadThreshold(tenant_id, db);

  if (NEVER_AUTO_ACCEPT.has(document_type)) {
    return {
      route: "review",
      reason: `document_type "${document_type}" never auto-accepts (§14.8 / §34 hard rule)`,
      threshold_used: threshold,
    };
  }

  if (validation_flags.length > 0) {
    return {
      route: "review",
      reason: `${validation_flags.length} validation flag(s): ${validation_flags.map((f) => f.flag).join(", ")}`,
      threshold_used: threshold,
    };
  }

  if (overall_confidence < threshold) {
    return {
      route: "review",
      reason: `confidence ${overall_confidence.toFixed(3)} below threshold ${threshold.toFixed(3)}`,
      threshold_used: threshold,
    };
  }

  return {
    route: "auto_accept",
    reason: `confidence ${overall_confidence.toFixed(3)} ≥ threshold ${threshold.toFixed(3)} and 0 validation flags`,
    threshold_used: threshold,
  };
}

async function loadThreshold(
  tenant_id: string,
  db: Pick<SupabaseClient, "from">,
): Promise<number> {
  // Per-tenant override first.
  const { data: tenantRow } = await db
    .from("tenant_settings")
    .select("import_auto_accept_threshold")
    .eq("tenant_id", tenant_id)
    .maybeSingle();

  const tenantOverride = (tenantRow as { import_auto_accept_threshold?: number | null } | null)?.import_auto_accept_threshold;
  if (typeof tenantOverride === "number" && Number.isFinite(tenantOverride)) {
    return clamp01(tenantOverride);
  }

  // Fall through to platform_settings default.
  const { data: platformRow } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", PLATFORM_DEFAULT_KEY)
    .maybeSingle();

  const raw = (platformRow as { value?: unknown } | null)?.value;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? clamp01(n) : 0.8; // hard fallback if platform_settings is missing
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

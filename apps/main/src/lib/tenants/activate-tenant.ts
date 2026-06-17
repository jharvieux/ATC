import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait, safeAwaitRowCount } from "@/lib/db/safe-mutation";
import { type OnboardingStage } from "@/lib/onboarding/state-machine";

interface ActivateTenantOptions {
  /** When set, adds a CAS guard on onboarding_stage and asserts 1 row matched. */
  casStage?: OnboardingStage;
}

export async function activateTenant(
  db: SupabaseClient,
  tenantId: string,
  extraFields?: Record<string, unknown>,
  options?: ActivateTenantOptions,
): Promise<void> {
  const fields: Record<string, unknown> = {
    status: "active",
    activated_at: new Date().toISOString(),
    onboarding_stage: "complete",
    ...extraFields,
  };

  if (options?.casStage) {
    // CAS guard: throws on zero rows so concurrent activations don't silently no-op.
    await safeAwaitRowCount(
      db
        .from("tenants")
        .update(fields)
        .eq("id", tenantId)
        .eq("onboarding_stage", options.casStage)
        .select("id"),
      "tenants.update.activate",
      1,
    );
  } else {
    // No CAS: PK isolation only. All non-CAS callers use a platform-admin
    // service-role client scoped to a validated tenantId — the admin route
    // verifies the session and the tenant row existence before calling here.
    await safeAwait(
      db.from("tenants").update(fields).eq("id", tenantId),
      "tenants.update.activate",
    );
  }
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwaitRequired, safeAwaitRowCount } from "@/lib/db/safe-mutation";
import { type OnboardingStage } from "@/lib/onboarding/state-machine";
import { publishTenantEvent } from "@/lib/rag-sync/publish-tenant-event";

interface ActivateTenantOptions {
  /** When set, adds a CAS guard on onboarding_stage and asserts 1 row matched. */
  casStage?: OnboardingStage;
}

type ActivatedRow = { tenant_type: string; display_name: string };

// Columns the RAG tenant.status_changed event payload needs back from the update.
const ACTIVATION_RETURNING = "tenant_type, display_name";

export async function activateTenant(
  db: SupabaseClient,
  tenantId: string,
  extraFields?: Record<string, unknown>,
  options?: ActivateTenantOptions,
): Promise<void> {
  // Monotonic version stamp so the RAG shadow's stale-revision guard accepts
  // this change: the prior tenant.created event sent source_revision 0, and
  // /api/tenant-events ignores any event whose revision is <= the stored one.
  // Epoch-seconds matches the platform-settings publisher convention, and we
  // persist the same value to tenants.source_revision so the nightly reconcile
  // sees no spurious drift.
  const sourceRevision = Math.floor(Date.now() / 1000);

  const fields: Record<string, unknown> = {
    status: "active",
    activated_at: new Date().toISOString(),
    onboarding_stage: "complete",
    ...extraFields,
    // After the spread on purpose: the emitted event's source_revision must
    // equal what's persisted here, so a caller cannot override the monotonic
    // stamp via extraFields and desync the RAG stale-revision guard.
    source_revision: sourceRevision,
  };

  let row: ActivatedRow;
  if (options?.casStage) {
    // CAS guard: throws on zero rows so concurrent activations don't silently no-op.
    const rows = await safeAwaitRowCount<ActivatedRow>(
      db
        .from("tenants")
        .update(fields)
        .eq("id", tenantId)
        .eq("onboarding_stage", options.casStage)
        .select(ACTIVATION_RETURNING),
      "tenants.update.activate",
      1,
    );
    row = rows[0]!;
  } else {
    // No CAS: PK isolation only. All non-CAS callers use a platform-admin
    // service-role client scoped to a validated tenantId — the admin route
    // verifies the session and the tenant row existence before calling here.
    row = await safeAwaitRequired<ActivatedRow>(
      db.from("tenants").update(fields).eq("id", tenantId).select(ACTIVATION_RETURNING).single(),
      "tenants.update.activate",
    );
  }

  // §8.7 — propagate the activation to RAG's tenant_registry_shadow. Without
  // this the shadow stays 'onboarding' and the RAG verifier rejects retrieval
  // with 403 tenant_inactive, so chat answers fall back to ungrounded. This was
  // the gap: activation previously emitted no event (only signup did), and the
  // nightly reconcile is the only backstop. Best-effort by design —
  // publishTenantEvent enqueues to Inngest (rag-sync-deliver owns delivery +
  // retries) and never throws, so RAG being unreachable cannot fail activation.
  await publishTenantEvent({
    event_type: "tenant.status_changed",
    tenant_id: tenantId,
    source_revision: sourceRevision,
    payload: { status: "active", tenant_type: row.tenant_type, display_name: row.display_name },
  });
}

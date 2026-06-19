import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwaitRequired } from "@/lib/db/safe-mutation";
import { publishTenantEvent, type TenantEventType } from "./publish-tenant-event";

type ShadowRow = { status: string; tenant_type: string; display_name: string };

// Propagate a tenant lifecycle change to RAG's tenant_registry_shadow.
//
// Call this AFTER the status/metadata write has committed. It stamps a
// monotonic source_revision into tenants (epoch-seconds, matching activateTenant
// and the platform-settings publisher) so RAG's stale-revision guard accepts the
// event and the nightly reconcile sees no spurious drift, reads back the
// canonical row, and publishes the event with the row's current values.
//
// Best-effort by design — it NEVER throws. The primary lifecycle op (suspend,
// terminate, profile edit) has already committed; a sync-emit failure must not
// roll it back or fail a cron's other side-effects. The nightly reconcile
// backstops any dropped event. (publishTenantEvent itself already queues to
// pending_rag_sync on delivery failure; this wrapper additionally swallows a
// failed revision bump.)
export async function publishTenantShadowEvent(
  db: SupabaseClient,
  tenantId: string,
  eventType: TenantEventType,
): Promise<void> {
  const sourceRevision = Math.floor(Date.now() / 1000);

  let row: ShadowRow;
  try {
    row = await safeAwaitRequired<ShadowRow>(
      db
        .from("tenants")
        .update({ source_revision: sourceRevision })
        .eq("id", tenantId)
        .select("status, tenant_type, display_name")
        .single(),
      "tenants.bump_source_revision",
    );
  } catch (err) {
    console.error("[rag-sync] tenant shadow revision bump failed; reconcile will backstop", {
      tenant_id: tenantId,
      event_type: eventType,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  await publishTenantEvent({
    event_type: eventType,
    tenant_id: tenantId,
    source_revision: sourceRevision,
    payload: { status: row.status, tenant_type: row.tenant_type, display_name: row.display_name },
  });
}

// §15.14.2 — Tenant termination side-effects.
// Triggered when tenant.status transitions to 'terminated' (not 'suspended').
//
// Side-effects (§15.14.2):
//   1. Custom domain unbind — indirected via Inngest event (BP18 not yet shipped)
//   2. OAuth tokens (host adapter credentials) deleted
//   3. Custom branding kept for audit
//   4. Customer data retained per §25.2 (no action at termination)
//   5. RAG chunks handled per §15.14.3 (Task 2 below)
//
// §15.14.3 — Chunk handling:
//   tenant-scoped chunks: 90d retention then hard-delete (separate cron)
//   globally-promoted chunks:
//     voluntary / involuntary_other → reviewed_retained (non-blocking alert)
//     involuntary_content → pending (all go to post-termination review queue)
//
// The RAG-side update is performed via a privileged POST to the RAG service admin endpoint.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";
import { safeAwait } from "@/lib/db/safe-mutation";

interface TenantTerminationScheduledPayload {
  tenant_id: string;
  kind: "voluntary" | "involuntary_content" | "involuntary_other";
  terminate_at: string;
  admin_user_id: string;
}

export const tenantTerminationScheduled = inngest.createFunction(
  {
    id: "tenant-termination-scheduled",
    triggers: [{ event: "tenant.termination_scheduled" }],
  },
  async ({ event }) => {
    const { tenant_id, kind, terminate_at } = event.data as TenantTerminationScheduledPayload;
    const db = createServiceRoleClient();

    // Wait until suspension_end_at before terminating.
    const terminateTime = new Date(terminate_at).getTime();
    if (Date.now() < terminateTime) {
      // Not yet due. The tenant-termination-finalize cron reconciles every
      // suspended-with-termination_kind tenant past its suspension_end_at, so
      // we defer here rather than self-rescheduling (no Inngest step/sleep yet).
      return { deferred: true, terminate_at };
    }

    const { finalized } = await finalizeTermination(db, tenant_id, kind);
    return { ok: true, finalized };
  },
);

export const tenantOnTerminatedSideEffects = inngest.createFunction(
  {
    id: "tenant-on-terminated-side-effects",
    triggers: [{ event: "tenant.terminated" }],
  },
  async ({ event }) => {
    const { tenant_id, kind } = event.data as { tenant_id: string; kind: string };
    const db = createServiceRoleClient();
    await onTerminated(db, tenant_id, kind as "voluntary" | "involuntary_content" | "involuntary_other");
  },
);

// Guarded CAS: suspended → terminated. Returns finalized:false (NOT an error)
// when zero rows match — that means the tenant was un-suspended / the
// termination was rescinded within the 90-day window (§15.14.3), a valid
// outcome that must not throw, or the nightly finalize cron would retry the
// same tenant forever. On a real transition we emit tenant.terminated so the
// idempotent tenantOnTerminatedSideEffects consumer runs the §15.14.2
// side-effects on its own Inngest function boundary (independent retry).
export async function finalizeTermination(
  db: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  kind: "voluntary" | "involuntary_content" | "involuntary_other",
): Promise<{ finalized: boolean }> {
  const updated = await safeAwait(
    db.from("tenants")
      .update({ status: "terminated", terminated_at: new Date().toISOString() })
      .eq("id", tenantId)
      .eq("status", "suspended")
      .select("id"),
    "tenants.finalize-termination",
  );

  if (!updated || (updated as Array<{ id: string }>).length === 0) {
    return { finalized: false };
  }

  await inngest.send({ name: "tenant.terminated", data: { tenant_id: tenantId, kind } });
  return { finalized: true };
}

async function onTerminated(
  db: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  kind: "voluntary" | "involuntary_content" | "involuntary_other",
): Promise<void> {
  // §15.14.2-1: Custom domain unbind via Inngest event indirection (BP18).
  await inngest.send({
    name: "tenant.custom_domain_removed_by_lifecycle",
    data: { tenant_id: tenantId, reason: "termination" },
  });

  // §15.14.2-2: Delete encrypted host adapter credentials.
  await safeAwait(db.from("tenant_host_configs")
    .update({ credentials_encrypted: null })
    .eq("tenant_id", tenantId), "tenant_host_configs.update");

  // §15.14.2-3: Custom branding kept — no action.
  // §15.14.2-4: Customer data retained per §25.2 — no action.

  // §15.14.3: Notify RAG service to mark globally-promoted chunks.
  const ragServiceUrl = process.env.RAG_SERVICE_URL;
  if (!ragServiceUrl) {
    console.warn("[tenant-on-terminated] RAG_SERVICE_URL not set — chunk marking skipped");
    return;
  }

  // BP09 — RS256 JWT. The tenant being terminated has shadow status
  // transitioning to 'terminated', which the rag verifier rejects (Step 6).
  // Use the PLATFORM sentinel; body.tenant_id still identifies the target.
  const jwt = await signServiceJwt({
    tenant_id: PLATFORM_SENTINEL_TENANT_ID,
    scope: "write",
    service_identifier: "platform-admin",
  });
  const postTermStatus = kind === "involuntary_content" ? "pending" : "reviewed_retained";

  const response = await fetch(`${ragServiceUrl}/api/admin/post-termination-mark`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      termination_kind: kind,
      post_termination_review_status: postTermStatus,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("[tenant-on-terminated] RAG chunk marking failed: %s %s", response.status, text);
    // Non-fatal — chunk marking can be retried via admin action.
  }
}

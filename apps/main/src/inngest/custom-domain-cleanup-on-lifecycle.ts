// §16.3.3 — Lifecycle cleanup: unbind custom domain on tenant.suspended /
// tenant.terminated / tenant.downgraded_from_agency / tenant.custom_domain_removed_by_tenant.
// Idempotent — if domain already unbound, exits cleanly.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { vercelRemoveDomain, CrownJewelGuardError } from "@/lib/vercel/domain-client";
import { safeAwait } from "@/lib/db/safe-mutation";

interface LifecyclePayload {
  tenant_id: string;
  reason?: string;
}

async function unbindCustomDomain(tenantId: string, reason: string): Promise<{ status: string }> {
  const db = createServiceRoleClient();

  const { data: tenant, error } = await db
    .from("tenants")
    .select("id, custom_domain, custom_domain_status")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !tenant) {
    console.warn("[custom-domain-cleanup] tenant not found: %s", tenantId);
    return { status: "tenant_not_found" };
  }

  const t = tenant as { custom_domain: string | null; custom_domain_status: string };
  if (!t.custom_domain || t.custom_domain_status === "unbound_lifecycle" || t.custom_domain_status === "none") {
    // Idempotent: nothing to do.
    return { status: "already_unbound" };
  }

  try {
    await vercelRemoveDomain(t.custom_domain);
  } catch (e) {
    if (e instanceof CrownJewelGuardError) {
      console.warn("[custom-domain-cleanup] non-production, skipping Vercel for %s", t.custom_domain);
    } else {
      console.error("[custom-domain-cleanup] Vercel remove failed for %s: %s", t.custom_domain, e);
      // Continue to update local state even if Vercel call fails — tenant lifecycle wins.
    }
  }

  await safeAwait(db
    .from("tenants")
    .update({
      custom_domain_status: "unbound_lifecycle",
      custom_domain_unbound_at: new Date().toISOString(),
    })
    .eq("id", tenantId), "tenants.update");

  console.info("[custom-domain-cleanup] unbound tenant=%s domain=%s reason=%s", tenantId, t.custom_domain, reason);
  return { status: "unbound" };
}

export const customDomainCleanupOnSuspend = inngest.createFunction(
  { id: "custom-domain-cleanup-on-suspend", triggers: [{ event: "tenant.suspended" }] },
  async ({ event }) => {
    const { tenant_id } = event.data as LifecyclePayload;
    return unbindCustomDomain(tenant_id, "suspended");
  },
);

export const customDomainCleanupOnTerminated = inngest.createFunction(
  { id: "custom-domain-cleanup-on-terminated", triggers: [{ event: "tenant.terminated" }] },
  async ({ event }) => {
    const { tenant_id } = event.data as LifecyclePayload;
    return unbindCustomDomain(tenant_id, "terminated");
  },
);

export const customDomainCleanupOnDowngrade = inngest.createFunction(
  { id: "custom-domain-cleanup-on-downgrade", triggers: [{ event: "tenant.downgraded_from_agency" }] },
  async ({ event }) => {
    const { tenant_id } = event.data as LifecyclePayload;
    return unbindCustomDomain(tenant_id, "downgraded_from_agency");
  },
);

export const customDomainCleanupOnTenantRemoval = inngest.createFunction(
  {
    id: "custom-domain-cleanup-on-tenant-removal",
    triggers: [{ event: "tenant.custom_domain_removed_by_tenant" }, { event: "tenant.custom_domain_removed_by_lifecycle" }],
  },
  async ({ event }) => {
    const { tenant_id, reason } = event.data as LifecyclePayload;
    return unbindCustomDomain(tenant_id, reason ?? "tenant_initiated");
  },
);

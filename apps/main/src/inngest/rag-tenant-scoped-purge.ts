// §15.14.3 — Daily purge of tenant-scoped chunks from terminated tenants after 90 days.
// Runs daily at 01:00 UTC.
// Only deletes scope='tenant' chunks; globally-promoted chunks are NEVER auto-deleted.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";

export const ragTenantScopedPurgeOnTermination = inngest.createFunction(
  {
    id: "rag-tenant-scoped-purge-on-termination",
    triggers: [{ cron: "0 1 * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();

    // Find terminated tenants whose 90-day window has passed.
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: tenants, error } = await db
      .from("tenants")
      .select("id")
      .eq("status", "terminated")
      .lt("terminated_at", cutoff);

    if (error) {
      console.error("[rag-tenant-scoped-purge] Failed to fetch terminated tenants: %s", error.message);
      return;
    }

    const ragServiceUrl = process.env.RAG_SERVICE_URL;
    if (!ragServiceUrl) {
      console.warn("[rag-tenant-scoped-purge] RAG_SERVICE_URL not set — purge skipped");
      return;
    }

    for (const tenant of tenants ?? []) {
      // BP09 — RS256 JWT carries the PLATFORM sentinel. The tenant being
      // purged has status='terminated' in tenant_registry_shadow, and the
      // rag verifier rejects non-active tenants (verify-service-jwt.ts
      // Step 6). The sentinel + body.tenant_id splits authorization
      // (must be platform-admin) from target (the terminated tenant).
      let jwt: string;
      try {
        jwt = await signServiceJwt({
          tenant_id: PLATFORM_SENTINEL_TENANT_ID,
          scope: "write",
          service_identifier: "platform-admin",
        });
      } catch (err) {
        console.error("[rag-tenant-scoped-purge] JWT signing failed for tenant %s: %s",
          tenant.id, err instanceof Error ? err.message : String(err));
        continue;
      }

      const response = await fetch(`${ragServiceUrl}/api/admin/purge-tenant-scoped-chunks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${jwt}`,
        },
        body: JSON.stringify({ tenant_id: tenant.id }),
      });

      if (!response.ok) {
        console.error("[rag-tenant-scoped-purge] Purge failed for tenant %s: %s", tenant.id, response.status);
      } else {
        console.info("[rag-tenant-scoped-purge] Purged tenant-scoped chunks for terminated tenant=%s", tenant.id);
      }
    }
  },
);

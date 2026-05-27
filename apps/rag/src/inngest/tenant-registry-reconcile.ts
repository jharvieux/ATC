// §8.3 — Nightly reconcile: diff main app tenants against tenant_registry_shadow
//
// Handles three cases:
//   • Present in main but absent in shadow → insert
//   • Present in both with different fields → update (use main's source_revision)
//   • Present in shadow but absent in main → log warning (investigate manually)
//
// Service-role import permitted: background job, no user session.
// This file is in the no-direct-service-role-import allowlist.

import { createClient } from "@supabase/supabase-js";
import { inngest } from "./client";
import { safeAwait } from "@/lib/db/safe-mutation";

type MainTenant = {
  id: string;
  status: string;
  tenant_type: string;
  display_name: string;
  source_revision: number;
};

type ShadowRow = {
  tenant_id: string;
  status: string;
  tenant_type: string;
  display_name: string;
  source_revision: number;
};

export const tenantRegistryReconcile = inngest.createFunction(
  { id: "tenant-registry-reconcile", triggers: [{ cron: "0 3 * * *" }] },
  async () => {
    const mainAppUrl = process.env.MAIN_APP_URL;
    const adminKey = process.env.MAIN_APP_ADMIN_API_KEY;
    if (!mainAppUrl || !adminKey) {
      throw new Error("MAIN_APP_URL or MAIN_APP_ADMIN_API_KEY not set");
    }

    // Fetch canonical tenant list from main app
    const res = await fetch(
      `${mainAppUrl}/api/admin/tenants?fields=id,status,tenant_type,display_name,source_revision`,
      { headers: { Authorization: `Bearer ${adminKey}` } },
    );
    if (!res.ok) {
      throw new Error(`Main app admin API returned ${res.status}`);
    }
    const { tenants: mainTenants }: { tenants: MainTenant[] } = await res.json();

    const db = createClient(
      process.env.SUPABASE_RAG_URL!,
      process.env.SUPABASE_RAG_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data: shadowRows, error } = await db
      .from("tenant_registry_shadow")
      .select("tenant_id, status, tenant_type, display_name, source_revision");

    if (error) throw error;

    const shadowMap = new Map<string, ShadowRow>(
      (shadowRows ?? []).map((r) => [r.tenant_id, r as ShadowRow]),
    );
    const mainMap = new Map<string, MainTenant>(
      mainTenants.map((t) => [t.id, t]),
    );

    let inserted = 0;
    let updated = 0;

    for (const tenant of mainTenants) {
      const shadow = shadowMap.get(tenant.id);

      if (!shadow) {
        // Present in main, absent in shadow — insert
        await safeAwait(db.from("tenant_registry_shadow").insert({
          tenant_id: tenant.id,
          status: tenant.status,
          tenant_type: tenant.tenant_type,
          display_name: tenant.display_name,
          source_revision: tenant.source_revision,
          last_reconcile_sync_at: new Date().toISOString(),
        }), "tenant_registry_shadow.insert");
        console.warn("[reconcile] inserted missing tenant", { tenant_id: tenant.id });
        inserted++;
        continue;
      }

      const drifted =
        shadow.status !== tenant.status ||
        shadow.tenant_type !== tenant.tenant_type ||
        shadow.display_name !== tenant.display_name ||
        shadow.source_revision !== tenant.source_revision;

      if (drifted) {
        await safeAwait(db.from("tenant_registry_shadow").update({
          status: tenant.status,
          tenant_type: tenant.tenant_type,
          display_name: tenant.display_name,
          source_revision: tenant.source_revision,
          last_reconcile_sync_at: new Date().toISOString(),
        }).eq("tenant_id", tenant.id), "tenant_registry_shadow.update");
        console.warn("[reconcile] corrected drifted tenant", { tenant_id: tenant.id });
        updated++;
      } else {
        // No drift — just update last_reconcile_sync_at
        await safeAwait(db.from("tenant_registry_shadow").update({
          last_reconcile_sync_at: new Date().toISOString(),
        }).eq("tenant_id", tenant.id), "tenant_registry_shadow.update");
      }
    }

    // Shadow rows absent from main — usually means tenant got deleted from
    // main; investigate manually. The PLATFORM sentinel (all-zero UUID,
    // tenant_type='platform') is intentional and does NOT live in main —
    // skip it silently.
    const PLATFORM_SENTINEL_ID = "00000000-0000-0000-0000-000000000000";
    for (const [tenant_id, row] of shadowMap) {
      if (tenant_id === PLATFORM_SENTINEL_ID) continue;
      if (row.tenant_type === "platform") continue;
      if (!mainMap.has(tenant_id)) {
        console.warn("[reconcile] tenant in shadow but absent from main — investigate", { tenant_id });
      }
    }

    return { inserted, updated };
  },
);

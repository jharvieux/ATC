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

// Exported for testing. A `redirect: "manual"` fetch yields either an
// "opaqueredirect" response (Node/undici: type set, status 0) or a raw 3xx.
// Following such a redirect cross-origin (e.g. apex→www, or the Vercel
// deployment-protection wall on atc-main.vercel.app) strips the Authorization
// header on the next hop, turning an authenticated request into an anonymous
// one that often returns a 200 HTML login page — a silent, confusing failure.
// Callers must fail loud instead of following it. (Issue #1273)
export function isCrossOriginRedirect(res: {
  type: string;
  status: number;
}): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

export const tenantRegistryReconcile = inngest.createFunction(
  {
    id: "tenant-registry-reconcile",
    triggers: [{ cron: "0 3 * * *" }],
    // Fires once after Inngest exhausts retries — previously this cron failed
    // silently into the retry queue (it never ran in prod for weeks; #1273).
    // RAG has no direct pager channel, so we log loudly for Sentry/log
    // aggregation, matching promo-state-drift-alert's convention.
    onFailure: async ({ error, runId }) => {
      console.error(
        "[tenant-registry-reconcile] PAGE PLATFORM ADMIN: nightly reconcile failed after all retries " +
          "(runId=%s): %s. tenant_registry_shadow will drift from main until fixed — verify atc-rag env: " +
          "MAIN_APP_URL must be the canonical, non-protected main domain (not atc-main.vercel.app) and " +
          "MAIN_APP_ADMIN_API_KEY must match main.",
        runId,
        error?.message ?? String(error),
      );
    },
  },
  async () => {
    const mainAppUrl = process.env.MAIN_APP_URL;
    const adminKey = process.env.MAIN_APP_ADMIN_API_KEY;
    if (!mainAppUrl || !adminKey) {
      throw new Error("MAIN_APP_URL or MAIN_APP_ADMIN_API_KEY not set");
    }

    // Fetch canonical tenant list from main app. redirect: "manual" so a
    // cross-origin redirect can't silently strip the bearer (see #1273).
    const res = await fetch(
      `${mainAppUrl}/api/admin/tenants?fields=id,status,tenant_type,display_name,source_revision`,
      { headers: { Authorization: `Bearer ${adminKey}` }, redirect: "manual" },
    );
    if (isCrossOriginRedirect(res)) {
      throw new Error(
        `Main app admin API redirected (status ${res.status || "opaque"}) — a cross-origin redirect ` +
          `strips the Bearer token. Set MAIN_APP_URL to the canonical, non-protected main domain.`,
      );
    }
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
        // Chain .select so we can tell whether a row was actually matched.
        // The shadow snapshot above can race a concurrent delete (tenant
        // removed from the shadow between the read and this write), in which
        // case the update no-ops and returns zero rows. We tolerate that race
        // — it self-corrects on the next nightly run, so forcing an Inngest
        // retry would be noise — but the returned `updated` count must reflect
        // real corrections, so only increment when a row was actually matched.
        const corrected = await safeAwait(db.from("tenant_registry_shadow").update({
          status: tenant.status,
          tenant_type: tenant.tenant_type,
          display_name: tenant.display_name,
          source_revision: tenant.source_revision,
          last_reconcile_sync_at: new Date().toISOString(),
        }).eq("tenant_id", tenant.id).select("tenant_id"), "tenant_registry_shadow.update");
        if (corrected && corrected.length > 0) {
          console.warn("[reconcile] corrected drifted tenant", { tenant_id: tenant.id });
          updated++;
        }
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

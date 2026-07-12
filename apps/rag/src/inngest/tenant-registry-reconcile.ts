// §8.3 — Nightly reconcile: diff main app tenants against tenant_registry_shadow
//
// Handles three cases:
//   • Present in main but absent in shadow → insert
//   • Present in both with different fields → update (use main's source_revision)
//   • Present in shadow but absent in main → log warning (investigate manually)
//
// Background job, no user session — the service-role DB env lives in getRagDb().

import { inngest } from "./client";
import { getRagDb } from "@/lib/db/supabase";
import { safeAwait } from "@/lib/db/safe-mutation";
import { isCrossOriginRedirect } from "@/lib/http/redirect-guard";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

// #1789 — platform-wide nightly reconcile; bounded concurrency instead of
// one tenant at a time.
const RECONCILE_CONCURRENCY = 20;

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

    const db = getRagDb();

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

    // Each tenant's insert/update targets a distinct tenant_id row —
    // independent of every other tenant's, so fan out with a concurrency
    // bound instead of one round-trip at a time.
    const outcomes = await mapWithConcurrency(mainTenants, RECONCILE_CONCURRENCY, async (tenant) => {
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
        return "inserted" as const;
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
          return "updated" as const;
        }
        return "noop" as const;
      }

      // No drift — just touch last_reconcile_sync_at. Same concurrent-delete
      // race as the drifted path, but tolerated without a row-match check:
      // this write is uncounted and the field has no downstream consumer, so
      // a silent no-op on a deleted row is harmless and self-corrects next run.
      await safeAwait(db.from("tenant_registry_shadow").update({
        last_reconcile_sync_at: new Date().toISOString(),
      }).eq("tenant_id", tenant.id), "tenant_registry_shadow.update");
      return "noop" as const;
    });

    const inserted = outcomes.filter((o) => o === "inserted").length;
    const updated = outcomes.filter((o) => o === "updated").length;

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

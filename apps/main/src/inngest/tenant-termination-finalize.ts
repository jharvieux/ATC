// §15.14 — Nightly reconcile cron that finalizes tenant terminations.
//
// tenant-termination-scheduled defers when a tenant's suspension_end_at is in
// the future (no Inngest sleep yet). This cron is the durable backstop: each
// night it scans for suspended tenants whose 90-day window has elapsed and
// drives them to 'terminated' via the shared finalizeTermination CAS.
//
// The `termination_kind IS NOT NULL` filter is load-bearing — abuse-suspended
// tenants (suspended for reasons OTHER than scheduled termination) have a null
// termination_kind and must NOT be finalized here.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { finalizeTermination } from "./tenant-on-terminated";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

// #1789 — each tenant's finalize is an independent CAS transition; the
// existing per-tenant try/catch already isolates failures from each other.
const FINALIZE_CONCURRENCY = 10;

export const tenantTerminationFinalize = inngest.createFunction(
  {
    id: "tenant-termination-finalize",
    triggers: [{ cron: "0 3 * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();

    const { data: due, error } = await db
      .from("tenants")
      .select("id, termination_kind")
      .eq("status", "suspended")
      .not("termination_kind", "is", null)
      .lte("suspension_end_at", new Date().toISOString());

    if (error) {
      throw new Error(`[tenant-termination-finalize] scan failed: ${error.message}`);
    }

    const rows = (due ?? []) as Array<{
      id: string;
      termination_kind: "voluntary" | "involuntary_content" | "involuntary_other";
    }>;

    const results = await mapWithConcurrency(rows, FINALIZE_CONCURRENCY, async (t) => {
      try {
        const { finalized } = await finalizeTermination(db, t.id, t.termination_kind);
        return { tenant_id: t.id, ok: true as const, finalized };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[tenant-termination-finalize] tenant %s failed: %s", t.id, message);
        return { tenant_id: t.id, ok: false as const, error: message };
      }
    });

    let finalizedCount = 0;
    const failures: Array<{ tenant_id: string; error: string }> = [];
    for (const r of results) {
      if (r.ok) {
        if (r.finalized) finalizedCount++;
      } else {
        failures.push({ tenant_id: r.tenant_id, error: r.error });
      }
    }

    // Fail loud so Inngest retries the run — but only AFTER attempting every
    // due tenant, so one bad row can't starve the rest.
    if (failures.length > 0) {
      throw new Error(
        `[tenant-termination-finalize] ${failures.length}/${rows.length} failed: ${JSON.stringify(failures)}`,
      );
    }

    return { scanned: rows.length, finalized: finalizedCount };
  },
);

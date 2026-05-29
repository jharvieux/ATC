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

    let finalizedCount = 0;
    const failures: Array<{ tenant_id: string; error: string }> = [];

    for (const t of rows) {
      try {
        const { finalized } = await finalizeTermination(db, t.id, t.termination_kind);
        if (finalized) finalizedCount++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[tenant-termination-finalize] tenant %s failed: %s", t.id, message);
        failures.push({ tenant_id: t.id, error: message });
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

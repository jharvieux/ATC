// §16.3.2 — Hourly sweep: after 72h grace, remove Vercel binding for TXT-drifted tenants.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { vercelRemoveDomain, CrownJewelGuardError } from "@/lib/vercel/domain-client";
import { safeAwait } from "@/lib/db/safe-mutation";

export const customDomainTxtGraceSweep = inngest.createFunction(
  {
    id: "custom-domain-txt-grace-sweep",
    triggers: [{ cron: "0 * * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();

    // 72-hour cutoff: last_reverified_at < NOW() - 72h (i.e., grace expired).
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

    const { data: tenants, error } = await db
      .from("tenants")
      .select("id, custom_domain")
      .eq("custom_domain_status", "txt_drifted")
      .lt("custom_domain_last_reverified_at", cutoff);

    if (error) {
      console.error("[custom-domain-txt-grace-sweep] fetch failed: %s", error.message);
      return;
    }

    let swept = 0;
    for (const row of (tenants ?? []) as { id: string; custom_domain: string }[]) {
      try {
        await vercelRemoveDomain(row.custom_domain);
      } catch (e) {
        if (e instanceof CrownJewelGuardError) {
          // Non-production: just log status change, skip Vercel.
          console.warn("[custom-domain-txt-grace-sweep] non-production, skipping Vercel for %s", row.custom_domain);
        } else {
          console.error("[custom-domain-txt-grace-sweep] Vercel remove failed for %s: %s", row.custom_domain, e);
          continue;
        }
      }

      await safeAwait(db
        .from("tenants")
        .update({
          custom_domain_status: "txt_grace_expired",
          custom_domain_unbound_at: new Date().toISOString(),
        })
        .eq("id", row.id), "tenants.update");
      swept++;
      console.info("[custom-domain-txt-grace-sweep] expired grace for tenant=%s domain=%s", row.id, row.custom_domain);
    }

    return { swept };
  },
);

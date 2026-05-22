// §16.3.2 — Weekly re-verification of all verified custom domains.
// Sundays at 03:00 UTC.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { lookupCname, lookupTxt } from "@/lib/dns/doh-resolver";
import { vercelRemoveDomain, CrownJewelGuardError } from "@/lib/vercel/domain-client";

export const customDomainReverify = inngest.createFunction(
  {
    id: "custom-domain-reverify",
    triggers: [{ cron: "0 3 * * 0" }],
  },
  async () => {
    const db = createServiceRoleClient();
    const reservedParent = (process.env.RESERVED_PARENT_DOMAIN ?? "tenants.ai-travelconcierge.com").toLowerCase();

    const { data: tenants, error } = await db
      .from("tenants")
      .select("id, custom_domain, custom_domain_verification_token, custom_domain_status")
      .eq("custom_domain_status", "verified");

    if (error) {
      console.error("[custom-domain-reverify] fetch failed: %s", error.message);
      return;
    }

    let checked = 0;
    let drifted = 0;

    for (const row of (tenants ?? []) as {
      id: string;
      custom_domain: string;
      custom_domain_verification_token: string;
    }[]) {
      checked++;

      try {
        const [cnameTarget, txtValues] = await Promise.all([
          lookupCname(row.custom_domain),
          lookupTxt(`_verify.${row.custom_domain}`),
        ]);

        const cnameOk = cnameTarget === reservedParent;
        const txtOk = txtValues.includes(row.custom_domain_verification_token);

        if (cnameOk && txtOk) {
          // Both still match — update timestamp, no tenant-visible signal.
          await db
            .from("tenants")
            .update({ custom_domain_last_reverified_at: new Date().toISOString() })
            .eq("id", row.id);
          continue;
        }

        if (!cnameOk) {
          // CNAME drifted — remove binding within 1 hour, alert tenant.
          try {
            await vercelRemoveDomain(row.custom_domain);
          } catch (e) {
            if (!(e instanceof CrownJewelGuardError)) {
              console.error("[custom-domain-reverify] Vercel remove failed for %s: %s", row.custom_domain, e);
            }
          }
          await db
            .from("tenants")
            .update({
              custom_domain_status: "cname_drifted",
              custom_domain_unbound_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          drifted++;
          // TODO(notifications): email tenant via Resend with drift explanation.
          console.warn("[custom-domain-reverify] CNAME drift tenant=%s domain=%s", row.id, row.custom_domain);
          continue;
        }

        // TXT drifted — keep binding for 72h grace, set status.
        await db
          .from("tenants")
          .update({
            custom_domain_status: "txt_drifted",
            custom_domain_last_reverified_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        drifted++;
        // TODO(notifications): email tenant with TXT drift + 72h grace warning.
        console.warn("[custom-domain-reverify] TXT drift tenant=%s domain=%s (72h grace started)", row.id, row.custom_domain);
      } catch (e) {
        console.error("[custom-domain-reverify] check failed for tenant %s: %s", row.id, e);
      }
    }

    console.info("[custom-domain-reverify] checked=%d drifted=%d", checked, drifted);
    return { checked, drifted };
  },
);

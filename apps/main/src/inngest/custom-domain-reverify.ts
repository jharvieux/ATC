// §16.3.2 — Weekly re-verification of all verified custom domains.
// Sundays at 03:00 UTC.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { lookupCname, lookupTxt } from "@/lib/dns/doh-resolver";
import { vercelRemoveDomain, CrownJewelGuardError } from "@/lib/vercel/domain-client";
import { safeAwait } from "@/lib/db/safe-mutation";

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
          await safeAwait(db
            .from("tenants")
            .update({ custom_domain_last_reverified_at: new Date().toISOString() })
            .eq("id", row.id), "tenants.update");
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
          await safeAwait(db
            .from("tenants")
            .update({
              custom_domain_status: "cname_drifted",
              custom_domain_unbound_at: new Date().toISOString(),
            })
            .eq("id", row.id), "tenants.update");
          drifted++;
          console.warn("[custom-domain-reverify] CNAME drift tenant=%s domain=%s", row.id, row.custom_domain);
          await notifyDomainDrift(db, row.id, row.custom_domain, "cname_drifted");
          continue;
        }

        // TXT drifted — keep binding for 72h grace, set status.
        await safeAwait(db
          .from("tenants")
          .update({
            custom_domain_status: "txt_drifted",
            custom_domain_last_reverified_at: new Date().toISOString(),
          })
          .eq("id", row.id), "tenants.update");
        drifted++;
        console.warn("[custom-domain-reverify] TXT drift tenant=%s domain=%s (72h grace started)", row.id, row.custom_domain);
        await notifyDomainDrift(db, row.id, row.custom_domain, "txt_drifted");
      } catch (e) {
        console.error("[custom-domain-reverify] check failed for tenant %s: %s", row.id, e);
      }
    }

    console.info("[custom-domain-reverify] checked=%d drifted=%d", checked, drifted);
    return { checked, drifted };
  },
);

async function notifyDomainDrift(
  db: ReturnType<typeof createServiceRoleClient>,
  tenant_id: string,
  domain: string,
  kind: "cname_drifted" | "txt_drifted",
): Promise<void> {
  try {
    const { data: owners } = await db
      .from("users")
      .select("email")
      .eq("tenant_id", tenant_id)
      .eq("status", "active");
    const recipients = ((owners ?? []) as Array<{ email: string }>).map((u) => u.email);
    if (recipients.length === 0) return;

    const { sendTenantNotification } = await import("@/lib/email/notifications");
    const isCname = kind === "cname_drifted";
    const subject = isCname
      ? `URGENT: Your custom domain ${domain} is no longer pointing to us`
      : `Action needed: TXT record drift on ${domain} (72-hour grace)`;
    const html = isCname
      ? `<h2>Your custom domain has drifted</h2>
         <p>The CNAME record for <strong>${domain}</strong> no longer
         points at our infrastructure. We've unbound it from your account
         to avoid serving traffic from a domain we don't control.</p>
         <p>To restore: in your DNS provider, set ${domain}'s CNAME back
         to the value we provided during setup, then re-add the domain in
         your tenant settings.</p>`
      : `<h2>TXT record drift detected</h2>
         <p>The TXT verification record for <strong>${domain}</strong>
         has changed. We're keeping your binding active for 72 hours
         while you investigate.</p>
         <p>If you didn't intend to change DNS, please restore the TXT
         record we provided during setup.</p>`;

    for (const to of recipients) {
      await sendTenantNotification({
        db,
        tenant_id,
        to,
        subject,
        html,
        category: "transactional",
        template_id: `custom_domain_${kind}`,
        template_variables: { domain },
      });
    }
  } catch (err) {
    console.warn(
      "[custom-domain-reverify] notification failed for tenant %s: %s",
      tenant_id,
      err instanceof Error ? err.message : String(err),
    );
  }
}

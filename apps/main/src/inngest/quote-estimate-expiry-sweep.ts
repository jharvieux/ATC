// §21.10.1 — Daily ESTIMATE quote auto-expiry sweep.
//
// Finds quotes that:
//   - have price_kind = 'estimate'
//   - were priced more than QUOTE_ESTIMATE_VALIDITY_DAYS ago
//   - are still in status='sent' and unaccepted
// and sends each contact a "request fresh quote" transactional email via the
// Resend pipeline (§23), then transitions the quote to status='expired'.
//
// Idempotency: each quote is marked expired AFTER its email sends. A process
// crash after email dispatch but before the status update results in a re-send
// on the next cron run — the double-send risk is accepted because preventing
// permanently stranded quotes (expired but never emailed) is higher priority
// for a daily low-stakes notification sweep.
//
// Cron: daily at 02:00 UTC. Cheap query; the partial index
// quotes_estimate_expiry_sweep_idx (migration 20260531000000) covers it.

import * as React from "react";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendEmail, type SendEmailInput } from "@/lib/email/send";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import { signUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { QuoteEstimateExpiredEmail } from "@/emails/QuoteEstimateExpiredEmail";
import { resolveEmailContent, renderOverrideBodyInLayout } from "@/lib/email/template-resolve";
import { selectRepresentativeOption } from "@/lib/quotes/representative-option";

const DEFAULT_VALIDITY_DAYS = 7;
// Cap per-run so the function can't time-out as quote volume grows. Oldest estimates
// processed first; any overflow is picked up on subsequent daily runs.
const BATCH_LIMIT = 200;
const TIME_BUDGET_MS = 55_000;

export const quoteEstimateExpirySweep = inngest.createFunction(
  {
    id: "quote-estimate-expiry-sweep",
    triggers: [{ cron: "0 2 * * *" }],
  },
  async () => {
    const validityDays = Number(process.env.QUOTE_ESTIMATE_VALIDITY_DAYS ?? DEFAULT_VALIDITY_DAYS);
    const cutoff = new Date(Date.now() - validityDays * 24 * 60 * 60 * 1000);
    const sweepStart = Date.now();

    const db = createServiceRoleClient();
    const { data: stale, error } = await db
      .from("quotes")
      .select("id, tenant_id, contact_id, user_id, customer_access_token")
      .eq("price_kind", "estimate")
      .eq("status", "sent")
      .is("customer_accepted_at", null)
      .lt("priced_at", cutoff.toISOString())
      .order("priced_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (error) {
      console.error("[quote-estimate-expiry-sweep] query failed:", error.message);
      return { expired: 0, emailed: 0, error: error.message };
    }

    const rows = (stale ?? []) as Array<{
      id: string;
      tenant_id: string;
      contact_id: string | null;
      user_id: string | null;
      customer_access_token: string | null;
    }>;

    if (rows.length === 0) {
      return { expired: 0, emailed: 0 };
    }

    // ── Batch-fetch contacts and tenants needed for email sends ─────────────
    const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => id !== null))];
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];

    const { data: contactsRaw, error: contactsErr } = await db
      .from("contacts")
      .select("id, first_name, last_name, email")
      .in("id", contactIds.length > 0 ? contactIds : ["00000000-0000-0000-0000-000000000000"])
      .in("tenant_id", tenantIds);

    if (contactsErr) {
      console.error("[quote-estimate-expiry-sweep] contacts fetch failed:", contactsErr.message);
      return { expired: 0, emailed: 0, error: contactsErr.message };
    }

    const { data: tenantsRaw, error: tenantsErr } = await db
      .from("tenants")
      // #1190: email_* / send-pattern / resend-key live on tenant_branding.
      .select("id, legal_name, mailing_address")
      .in("id", tenantIds);

    if (tenantsErr) {
      console.error("[quote-estimate-expiry-sweep] tenants fetch failed:", tenantsErr.message);
      return { expired: 0, emailed: 0, error: tenantsErr.message };
    }

    const { data: brandingsRaw, error: brandingsErr } = await db
      .from("tenant_branding")
      .select("tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name")
      .in("tenant_id", tenantIds);

    if (brandingsErr) {
      console.error("[quote-estimate-expiry-sweep] branding fetch failed:", brandingsErr.message);
      return { expired: 0, emailed: 0, error: brandingsErr.message };
    }

    // §38 — cruise/ship for the email subject + body live on quote_options now.
    // Batch-fetch options for all stale quotes (service-role → scope by BOTH
    // quote_id set and tenant_id, D-091 two-layer) and pick the representative
    // option per quote for its label.
    const { data: optionsRaw, error: optionsErr } = await db
      .from("quote_options")
      .select("quote_id, option_index, customer_selected, cruise_line, ship_name")
      .in("quote_id", rows.map((r) => r.id))
      .in("tenant_id", tenantIds);

    if (optionsErr) {
      console.error("[quote-estimate-expiry-sweep] options fetch failed:", optionsErr.message);
      return { expired: 0, emailed: 0, error: optionsErr.message };
    }

    type ContactRow = { id: string; first_name: string | null; last_name: string | null; email: string | null };
    type TenantRow = { id: string; legal_name: string | null; mailing_address: unknown };
    type BrandingRow = { tenant_id: string; logo_url: string | null; primary_color: string | null; secondary_color: string | null; accent_color: string | null; slogan: string | null; email_send_pattern: string | null; tenant_resend_api_key_encrypted: string | null; email_from_address: string | null; email_from_name: string | null };

    const contactMap = new Map<string, ContactRow>(
      ((contactsRaw ?? []) as ContactRow[]).map((c) => [c.id, c]),
    );
    const tenantMap = new Map<string, TenantRow>(
      ((tenantsRaw ?? []) as TenantRow[]).map((t) => [t.id, t]),
    );
    const brandingMap = new Map<string, BrandingRow>(
      ((brandingsRaw ?? []) as BrandingRow[]).map((b) => [b.tenant_id, b]),
    );

    type SweepOptionRow = {
      quote_id: string;
      option_index: number;
      customer_selected: boolean | null;
      cruise_line: string | null;
      ship_name: string | null;
    };
    const optionsByQuote = new Map<string, SweepOptionRow[]>();
    for (const o of (optionsRaw ?? []) as SweepOptionRow[]) {
      const existing = optionsByQuote.get(o.quote_id);
      if (existing) existing.push(o);
      else optionsByQuote.set(o.quote_id, [o]);
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";
    const { renderToStaticMarkup } = await import("react-dom/server");

    let emailed = 0;
    let expired = 0;
    for (const r of rows) {
      if (Date.now() - sweepStart >= TIME_BUDGET_MS) break;
      const contact = r.contact_id ? contactMap.get(r.contact_id) : null;
      if (!contact?.email) {
        console.info(
          `[quote-estimate-expiry-sweep] skip email: quote=${r.id} — no contact email`,
        );
        continue;
      }

      const tenant = tenantMap.get(r.tenant_id);
      if (!tenant) {
        // FK anomaly — tenant_id on quotes must always resolve; surface loudly.
        console.error(
          `[quote-estimate-expiry-sweep] skip email: quote=${r.id} — tenant ${r.tenant_id} not found`,
        );
        continue;
      }

      const branding = brandingMap.get(r.tenant_id) ?? {};
      const customerName =
        [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Traveler";
      const repOption = selectRepresentativeOption(optionsByQuote.get(r.id) ?? []);
      const cruiseLabel =
        [repOption?.cruise_line, repOption?.ship_name].filter(Boolean).join(" — ") || null;
      const refreshUrl = r.customer_access_token
        ? `${baseUrl}/q/${r.customer_access_token}`
        : null;

      const unsubToken = signUnsubscribeToken({
        email: contact.email,
        tenant_id: r.tenant_id,
        category: "transactional",
      });
      const unsubscribeUrl = `${baseUrl}/email/unsubscribe?token=${unsubToken}`;

      const layout = {
        branding: {
          logo_url: (branding as BrandingRow).logo_url ?? null,
          primary_color: (branding as BrandingRow).primary_color ?? null,
          secondary_color: (branding as BrandingRow).secondary_color ?? null,
          accent_color: (branding as BrandingRow).accent_color ?? null,
          slogan: (branding as BrandingRow).slogan ?? null,
        },
        tenant_legal_name: tenant.legal_name ?? "Your Travel Agency",
        tenant_business_address: formatMailingAddress(tenant.mailing_address),
        unsubscribe_url: unsubscribeUrl,
      };

      // #963 — tenant subject/body override → platform default. A failed
      // override read or render throws (fail loud → next sweep retries);
      // we never silently fall back or send an empty body.
      const resolved = await resolveEmailContent({
        db,
        tenant_id: r.tenant_id,
        email_type: "quote_estimate_expired",
        variables: {
          customer_name: customerName,
          cruise_label: cruiseLabel ?? "your cruise",
          refresh_url: refreshUrl ?? "",
          validity_days: String(validityDays),
        },
      });

      const html =
        resolved.overrideBodyText !== null
          ? await renderOverrideBodyInLayout(layout, resolved.overrideBodyText)
          : renderToStaticMarkup(
              React.createElement(QuoteEstimateExpiredEmail, {
                layout,
                customer_name: customerName,
                cruise_label: cruiseLabel,
                refresh_url: refreshUrl,
                validity_days: validityDays,
              }),
            );

      const tenantInput: SendEmailInput["tenant"] = {
        id: r.tenant_id,
        legal_name: tenant.legal_name ?? "Travel Agency",
        mailing_address: tenant.mailing_address ? String(tenant.mailing_address) : null,
        // #1190: email send config comes from tenant_branding.
        email_send_pattern: ((branding as BrandingRow).email_send_pattern ?? "platform_resend") as
          | "platform_resend"
          | "tenant_resend",
        tenant_resend_api_key_encrypted: (branding as BrandingRow).tenant_resend_api_key_encrypted ?? null,
        email_from_address: (branding as BrandingRow).email_from_address ?? null,
        email_from_name: (branding as BrandingRow).email_from_name ?? null,
      };

      // Default subject comes from the template registry; when there's no
      // cruise label the {{cruise_label}} variable falls back to "your
      // cruise" (deliberate small copy change from the pre-#963 wording).
      const subject = resolved.subject;

      const result = await sendEmail({
        db,
        tenant: tenantInput,
        to: contact.email,
        subject,
        template_id: "quote_estimate_expired",
        category: "transactional",
        html,
        ...(r.user_id ? { user_id: r.user_id } : {}),
        ...(r.contact_id ? { contact_id: r.contact_id } : {}),
      });

      if (result.status === "sent") {
        emailed++;
        const { data: updatedRows, error: updateErr } = await db
          .from("quotes")
          .update({ status: "expired", updated_at: new Date().toISOString() })
          .eq("id", r.id)
          .eq("status", "sent")
          .select("id");
        if (updateErr) {
          console.error(
            `[quote-estimate-expiry-sweep] update failed: quote=${r.id} reason=${updateErr.message}`,
          );
        } else if ((updatedRows?.length ?? 0) === 0) {
          console.warn(
            `[quote-estimate-expiry-sweep] quote=${r.id} already expired by concurrent process`,
          );
        } else {
          expired++;
        }
      } else if (result.status === "failed") {
        console.error(
          `[quote-estimate-expiry-sweep] send failed: quote=${r.id} reason=${result.reason ?? "unknown"}`,
        );
      } else if (result.status === "rate_limited") {
        // rate_limited means the contact was silently not emailed; log at warn
        // so operators see quota pressure before it affects more contacts.
        console.warn(
          `[quote-estimate-expiry-sweep] rate_limited: quote=${r.id} — contact not emailed`,
        );
      } else {
        console.info(
          `[quote-estimate-expiry-sweep] quote=${r.id} email_status=${result.status}`,
        );
      }
    }

    return { expired, emailed };
  },
);

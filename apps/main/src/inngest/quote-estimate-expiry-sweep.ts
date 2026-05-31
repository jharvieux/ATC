// §21.10.1 — Daily ESTIMATE quote auto-expiry sweep.
//
// Finds quotes that:
//   - have price_kind = 'estimate'
//   - were priced more than QUOTE_ESTIMATE_VALIDITY_DAYS ago
//   - are still in status='sent' and unaccepted
// and transitions them to status='expired', then sends each contact a
// "request fresh quote" transactional email via the Resend pipeline (§23).
//
// Idempotency: quotes are marked expired BEFORE the email loop. Because
// the sweep only selects status='sent', the same quote is never processed
// on a subsequent run, so no double-send is possible.
//
// Cron: daily at 02:00 UTC. Cheap query; the partial index
// quotes_estimate_expiry_sweep_idx (migration 20260531000000) covers it.

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendEmail, type SendEmailInput } from "@/lib/email/send";
import { signUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { QuoteEstimateExpiredEmail } from "@/emails/QuoteEstimateExpiredEmail";

const DEFAULT_VALIDITY_DAYS = 7;

export const quoteEstimateExpirySweep = inngest.createFunction(
  {
    id: "quote-estimate-expiry-sweep",
    triggers: [{ cron: "0 2 * * *" }],
  },
  async () => {
    const validityDays = Number(process.env.QUOTE_ESTIMATE_VALIDITY_DAYS ?? DEFAULT_VALIDITY_DAYS);
    const cutoff = new Date(Date.now() - validityDays * 24 * 60 * 60 * 1000);

    const db = createServiceRoleClient();
    const { data: stale, error } = await db
      .from("quotes")
      .select("id, tenant_id, contact_id, user_id, customer_access_token, cruise_line, ship_name")
      .eq("price_kind", "estimate")
      .eq("status", "sent")
      .is("customer_accepted_at", null)
      .lt("priced_at", cutoff.toISOString());

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
      cruise_line: string | null;
      ship_name: string | null;
    }>;

    if (rows.length === 0) {
      return { expired: 0, emailed: 0 };
    }

    const { error: updateErr } = await db
      .from("quotes")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .in("id", rows.map((r) => r.id));

    if (updateErr) {
      console.error("[quote-estimate-expiry-sweep] update failed:", updateErr.message);
      return { expired: 0, emailed: 0, error: updateErr.message };
    }

    // ── Batch-fetch contacts and tenants needed for email sends ─────────────
    const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => id !== null))];
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];

    const { data: contactsRaw, error: contactsErr } = await db
      .from("contacts")
      .select("id, first_name, last_name, email")
      .in("id", contactIds.length > 0 ? contactIds : ["00000000-0000-0000-0000-000000000000"]);

    if (contactsErr) {
      console.error("[quote-estimate-expiry-sweep] contacts fetch failed:", contactsErr.message);
      return { expired: rows.length, emailed: 0, error: contactsErr.message };
    }

    const { data: tenantsRaw, error: tenantsErr } = await db
      .from("tenants")
      .select("id, legal_name, mailing_address, email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name")
      .in("id", tenantIds);

    if (tenantsErr) {
      console.error("[quote-estimate-expiry-sweep] tenants fetch failed:", tenantsErr.message);
      return { expired: rows.length, emailed: 0, error: tenantsErr.message };
    }

    const { data: brandingsRaw, error: brandingsErr } = await db
      .from("tenant_branding")
      .select("tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan")
      .in("tenant_id", tenantIds);

    if (brandingsErr) {
      console.error("[quote-estimate-expiry-sweep] branding fetch failed:", brandingsErr.message);
      return { expired: rows.length, emailed: 0, error: brandingsErr.message };
    }

    type ContactRow = { id: string; first_name: string | null; last_name: string | null; email: string | null };
    type TenantRow = { id: string; legal_name: string | null; mailing_address: unknown; email_send_pattern: string | null; tenant_resend_api_key_encrypted: string | null; email_from_address: string | null; email_from_name: string | null };
    type BrandingRow = { tenant_id: string; logo_url: string | null; primary_color: string | null; secondary_color: string | null; accent_color: string | null; slogan: string | null };

    const contactMap = new Map<string, ContactRow>(
      ((contactsRaw ?? []) as ContactRow[]).map((c) => [c.id, c]),
    );
    const tenantMap = new Map<string, TenantRow>(
      ((tenantsRaw ?? []) as TenantRow[]).map((t) => [t.id, t]),
    );
    const brandingMap = new Map<string, BrandingRow>(
      ((brandingsRaw ?? []) as BrandingRow[]).map((b) => [b.tenant_id, b]),
    );

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";

    let emailed = 0;
    for (const r of rows) {
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
      const cruiseLabel =
        [r.cruise_line, r.ship_name].filter(Boolean).join(" — ") || null;
      const refreshUrl = r.customer_access_token
        ? `${baseUrl}/q/${r.customer_access_token}`
        : null;

      const unsubToken = signUnsubscribeToken({
        email: contact.email,
        tenant_id: r.tenant_id,
        category: "transactional",
      });
      const unsubscribeUrl = `${baseUrl}/email/unsubscribe?token=${unsubToken}`;

      const jsx = React.createElement(QuoteEstimateExpiredEmail, {
        layout: {
          branding: {
            logo_url: (branding as BrandingRow).logo_url ?? null,
            primary_color: (branding as BrandingRow).primary_color ?? null,
            secondary_color: (branding as BrandingRow).secondary_color ?? null,
            accent_color: (branding as BrandingRow).accent_color ?? null,
            slogan: (branding as BrandingRow).slogan ?? null,
          },
          tenant_legal_name: tenant.legal_name ?? "Your Travel Agency",
          tenant_business_address: tenant.mailing_address ? String(tenant.mailing_address) : "",
          unsubscribe_url: unsubscribeUrl,
        },
        customer_name: customerName,
        cruise_label: cruiseLabel,
        refresh_url: refreshUrl,
        validity_days: validityDays,
      });

      const html = renderToStaticMarkup(jsx);

      const tenantInput: SendEmailInput["tenant"] = {
        id: r.tenant_id,
        legal_name: tenant.legal_name ?? "Travel Agency",
        mailing_address: tenant.mailing_address ? String(tenant.mailing_address) : null,
        email_send_pattern: (tenant.email_send_pattern ?? "platform_resend") as
          | "platform_resend"
          | "tenant_resend",
        tenant_resend_api_key_encrypted: tenant.tenant_resend_api_key_encrypted ?? null,
        email_from_address: tenant.email_from_address ?? null,
        email_from_name: tenant.email_from_name ?? null,
      };

      const subject = cruiseLabel
        ? `Your estimate for ${cruiseLabel} has expired — request fresh pricing`
        : "Your cruise estimate has expired — request fresh pricing";

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
      } else if (result.status === "failed") {
        console.error(
          `[quote-estimate-expiry-sweep] send failed: quote=${r.id} reason=${result.reason ?? "unknown"}`,
        );
      } else {
        console.info(
          `[quote-estimate-expiry-sweep] quote=${r.id} email_status=${result.status}`,
        );
      }
    }

    return { expired: rows.length, emailed };
  },
);

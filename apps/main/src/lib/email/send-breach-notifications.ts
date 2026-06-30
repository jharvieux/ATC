// §25.9 — Batched breach notification dispatcher.
//
// SLA contract:
//   • Tenant admins: notify within 24h of discovery.
//   • Affected users: notify within 72h of discovery.
//
// The helper renders the two breach email templates via dynamic import of
// react-dom/server (same pattern as BP23 pre-cruise emails — Next.js App
// Router bundler rejects static react-dom/server imports). Each send goes
// through the BP23 sendEmail() helper so suppressions and rate limits apply
// normally.

import * as React from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/send";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import {
  BreachNotificationUser,
  type BreachNotificationUserProps,
} from "@/emails/BreachNotificationUser";
import {
  BreachNotificationTenantAdmin,
  type BreachNotificationTenantAdminProps,
} from "@/emails/BreachNotificationTenantAdmin";

export type BreachSeverity = "low" | "medium" | "high" | "critical";

export interface SendBreachInput {
  db: SupabaseClient;
  severity: BreachSeverity;
  // user emails + display names — caller assembles from the affected users query.
  affected_users: Array<{
    tenant_id: string;
    user_email: string;
    customer_name: string;
    user_id: string;
  }>;
  affected_tenant_admins: Array<{
    tenant_id: string;
    admin_email: string;
    recipient_name: string;
  }>;
  // Tenants record (legal_name, mailing_address, send pattern) — needed to
  // render the BrandedLayout footer. One entry per unique tenant_id touched.
  tenant_records: Record<string, {
    id: string;
    legal_name: string;
    mailing_address: string;
    email_send_pattern: "platform_resend" | "tenant_resend";
    tenant_resend_api_key_encrypted?: string | null;
    email_from_address?: string | null;
    email_from_name?: string | null;
  }>;
  summary_for_user: BreachNotificationUserProps["breach_summary"];
  summary_for_admin: Omit<BreachNotificationTenantAdminProps["breach_summary"], "affected_user_count"> & {
    affected_user_count_by_tenant: Record<string, number>;
  };
  platform_unsubscribe_url: string;
}

export interface SendBreachResult {
  user_sends_attempted: number;
  user_sends_succeeded: number;
  admin_sends_attempted: number;
  admin_sends_succeeded: number;
}

export async function sendBreachNotifications(
  input: SendBreachInput,
): Promise<SendBreachResult> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  let userSucceeded = 0;
  let adminSucceeded = 0;

  // ── Tenant admins first (24h SLA tighter than 72h user SLA) ──
  for (const admin of input.affected_tenant_admins) {
    const tenant = input.tenant_records[admin.tenant_id];
    if (!tenant) continue;
    const html = renderToStaticMarkup(
      React.createElement(BreachNotificationTenantAdmin, {
        layout: {
          branding: {},
          tenant_legal_name: tenant.legal_name,
          tenant_business_address: formatMailingAddress(tenant.mailing_address),
          unsubscribe_url: input.platform_unsubscribe_url,
        },
        recipient_name: admin.recipient_name,
        breach_summary: {
          severity: input.severity,
          discovered_at: input.summary_for_admin.discovered_at,
          affected_user_count: input.summary_for_admin.affected_user_count_by_tenant[admin.tenant_id] ?? 0,
          data_categories_affected: input.summary_for_admin.data_categories_affected,
          confirmed_or_suspected: input.summary_for_admin.confirmed_or_suspected,
          platform_oncall_contact_email: input.summary_for_admin.platform_oncall_contact_email,
          runbook_url: input.summary_for_admin.runbook_url,
          notification_due_to_users_at: input.summary_for_admin.notification_due_to_users_at ?? null,
        },
      }),
    );
    const result = await sendEmail({
      db: input.db,
      tenant,
      to: admin.admin_email,
      subject: `[Action required] ${input.severity.toUpperCase()} security incident affecting your tenant`,
      template_id: "breach_notification_tenant_admin",
      category: "transactional",
      html,
    });
    if (result.status === "sent") adminSucceeded++;
  }

  // ── Affected users (72h SLA) ──
  for (const u of input.affected_users) {
    const tenant = input.tenant_records[u.tenant_id];
    if (!tenant) continue;
    const html = renderToStaticMarkup(
      React.createElement(BreachNotificationUser, {
        layout: {
          branding: {},
          tenant_legal_name: tenant.legal_name,
          tenant_business_address: formatMailingAddress(tenant.mailing_address),
          unsubscribe_url: input.platform_unsubscribe_url,
        },
        customer_name: u.customer_name,
        breach_summary: input.summary_for_user,
      }),
    );
    const result = await sendEmail({
      db: input.db,
      tenant,
      to: u.user_email,
      subject: "Important security notice",
      template_id: "breach_notification_user",
      category: "transactional",
      html,
      user_id: u.user_id,
    });
    if (result.status === "sent") userSucceeded++;
  }

  return {
    user_sends_attempted: input.affected_users.length,
    user_sends_succeeded: userSucceeded,
    admin_sends_attempted: input.affected_tenant_admins.length,
    admin_sends_succeeded: adminSucceeded,
  };
}

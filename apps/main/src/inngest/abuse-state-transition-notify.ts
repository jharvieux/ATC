// §27.8 — Abuse state-transition notification consumer.
//
// Triggered by `abuse.state_transition`. Resolves operator-editable copy
// from platform_settings.abuse_notification_copy, looks up the tenant's
// admin recipients + branding, renders AbuseStateTransition, and sends
// through the canonical sendEmail (§23) — suppression, rate-limit, staging
// isolation, and vendor-health all apply the same as every other outbound
// email (#1580; the prior sendTenantEmail fork bypassed all of them).
//
// Also stamps usage_limit_events.notification_sent_to with the recipient
// list for forensic visibility.

// react-dom/server is dynamically imported inside the handler to avoid the
// Next.js App Router bundler restriction on top-level react-dom/server
// imports (same pattern as lib/email/send-breach-notifications.ts and
// inngest/precruise-generate-and-send.ts).
import * as React from "react";
import { z } from "zod";
import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { sendEmail, TENANT_BRANDING_COLUMNS } from "@/lib/email/send";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import { AbuseStateTransition } from "@/emails/AbuseStateTransition";
import { safeAwait } from "@/lib/db/safe-mutation";

interface NotificationCopy {
  subject_template: string;
  body_intro: string;
}

const AbuseStateTransitionPayloadSchema = z.object({
  tenant_id: z.string().optional(),
  dimension: z.enum(["ai_cost", "chat_volume", "email_volume", "group_invite", "rag_cap", "help_submission"]).optional(),
  from_state: z.string().optional(),
  to_state: z.string().optional(),
  metric_value: z.string().optional(),
  threshold_crossed: z.string().optional(),
  reason: z.string().optional(),
});

const PUBLIC_ORIGIN_PATH = "/settings/usage";

export const abuseStateTransitionNotify = inngest.createFunction(
  {
    id: "abuse-state-transition-notify",
    triggers: [{ event: "abuse.state_transition" }],
  },
  async ({ event }) => {
    const parsed = AbuseStateTransitionPayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[abuse-state-transition-notify] invalid event payload: %s", parsed.error.message);
      return { skipped: true, reason: "invalid_payload" };
    }
    const data = parsed.data;
    if (!data?.tenant_id || !data.dimension || !data.to_state) {
      return { skipped: "missing-payload-fields" };
    }
    // The state machine emits "ok" → first non-ok transition only; if to_state
    // is somehow back to "ok" we skip. Notifications are upward-only.
    if (data.to_state === "ok") {
      return { skipped: "no-notify-on-ok" };
    }

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-inngest",
        reason: "cross_tenant_admin",
        operation: `abuse_state_transition_notify:${data.tenant_id}:${data.dimension}:${data.to_state}`,
      },
      async (db) => {
        // 1. Lookup copy.
        const copyKey = `${data.dimension}.${data.to_state}`;
        const { data: settingRow } = await db
          .from("platform_settings")
          .select("value")
          .eq("key", "abuse_notification_copy")
          .maybeSingle();
        const copyMap = (settingRow as { value?: Record<string, NotificationCopy> } | null)?.value ?? {};
        const copy: NotificationCopy = copyMap[copyKey] ?? {
          subject_template: `Usage notice: ${data.dimension} → ${data.to_state}`,
          body_intro: `Your tenant transitioned to "${data.to_state}" for ${data.dimension}.`,
        };

        // 2. Lookup tenant branding + tenant admins.
        const { data: tRow } = await db
          .from("tenants")
          // #1190: real columns are legal_name / mailing_address (not
          // legal_business_name / business_address, which never existed).
          .select("id, legal_name, mailing_address")
          .eq("id", data.tenant_id)
          .maybeSingle();
        const tenantRow = tRow as { id: string; legal_name?: string; mailing_address?: string } | null;
        if (!tenantRow) return { skipped: "tenant-not-found" };

        const { data: bRow } = await db
          .from("tenant_branding")
          // #1935 — shared column list across all five branding-reading crons
          // so the projection can't drift out of sync again.
          .select(TENANT_BRANDING_COLUMNS)
          .eq("tenant_id", data.tenant_id)
          .maybeSingle();
        const branding = bRow as {
          logo_url?: string | null;
          primary_color?: string | null;
          secondary_color?: string | null;
          accent_color?: string | null;
          slogan?: string | null;
          email_send_pattern: "platform_resend" | "tenant_resend";
          tenant_resend_api_key_encrypted?: string | null;
          email_from_address?: string | null;
          email_from_name?: string | null;
          email_from_domain?: string | null;
          email_from_domain_verified_at?: string | null;
        } | null;

        // 3. Recipients: tenant admins.
        const { data: admins } = await db
          .from("users")
          // #1190: real column is display_name (users has no full_name).
          .select("id, email, display_name")
          .eq("tenant_id", data.tenant_id)
          .in("role", ["tenant_admin", "owner"])
          .limit(20);
        const adminList = (admins ?? []) as Array<{ id: string; email: string; display_name?: string | null }>;
        if (adminList.length === 0) {
          return { skipped: "no-tenant-admins" };
        }

        const usagePageUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}${PUBLIC_ORIGIN_PATH}`;

        const { renderToStaticMarkup } = await import("react-dom/server");

        // 4. Render + send per admin (independent recipients, bounded at 20
        // by the query above; each has its own idempotency key).
        const sendOutcomes = await Promise.all(adminList.map(async (admin) => {
          const html = renderToStaticMarkup(
            React.createElement(AbuseStateTransition, {
              layout: {
                branding: {
                  logo_url: branding?.logo_url ?? null,
                  primary_color: branding?.primary_color ?? null,
                  secondary_color: branding?.secondary_color ?? null,
                  accent_color: branding?.accent_color ?? null,
                  slogan: branding?.slogan ?? null,
                },
                tenant_legal_name: tenantRow.legal_name ?? "Your tenant",
                tenant_business_address: formatMailingAddress(tenantRow.mailing_address),
                unsubscribe_url: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/email/unsubscribe?u=${admin.id}`,
              },
              recipient_name: admin.display_name ?? "tenant administrator",
              dimension: data.dimension!,
              from_state: data.from_state ?? "ok",
              to_state: data.to_state!,
              subject_template: copy.subject_template,
              body_intro: copy.body_intro,
              detected_at: new Date().toISOString(),
              usage_page_url: usagePageUrl,
              metric_value: data.metric_value ?? null,
              threshold_crossed: data.threshold_crossed ?? null,
            }),
          );

          const result = await sendEmail({
            db,
            tenant: {
              id: tenantRow.id,
              legal_name: tenantRow.legal_name ?? "Your tenant",
              mailing_address: tenantRow.mailing_address ?? null,
              email_send_pattern: branding?.email_send_pattern ?? "platform_resend",
              tenant_resend_api_key_encrypted: branding?.tenant_resend_api_key_encrypted ?? null,
              email_from_address: branding?.email_from_address ?? null,
              email_from_name: branding?.email_from_name ?? null,
              email_from_domain: branding?.email_from_domain ?? null,
              email_from_domain_verified_at: branding?.email_from_domain_verified_at ?? null,
            },
            to: admin.email,
            subject: copy.subject_template,
            template_id: "abuse_state_transition",
            category: "transactional",
            html,
            user_id: admin.id,
            // Keyed on the transition + recipient so a step retry of this same
            // event doesn't double-send; a genuinely new transition (different
            // to_state) gets a new key and sends.
            idempotencyKey: `abuse_state_transition:${data.tenant_id}:${data.dimension}:${data.to_state}:${admin.id}`,
          });
          return { email: admin.email, sent: result.status === "sent" };
        }));
        const sentTo = sendOutcomes.filter((o) => o.sent).map((o) => o.email);

        // 5. Stamp the most-recent usage_limit_events row for this transition.
        const { data: eventRow } = await db
          .from("usage_limit_events")
          .select("id")
          .eq("tenant_id", data.tenant_id)
          .eq("dimension", data.dimension)
          .eq("to_state", data.to_state)
          .order("triggered_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (eventRow && sentTo.length > 0) {
          await safeAwait(db
            .from("usage_limit_events")
            .update({ notification_sent_to: sentTo })
            .eq("id", (eventRow as { id: string }).id), "usage_limit_events.update");
        }

        return {
          tenant_id: data.tenant_id,
          dimension: data.dimension,
          to_state: data.to_state,
          recipients_notified: sentTo.length,
        };
      },
    );
  },
);

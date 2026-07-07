// §18.8 — Daily reminder cadence for pending invitations.
//
// Cadence per months-before-sailing:
//   24+ months → every 6 weeks (42 days)
//   12–24 months → monthly    (30 days)
//   6–12 months → every 2 wks (14 days)
//   1–6 months  → weekly      (7 days)
//   <1 month    → null (final 30 days — "last chance" logic only, no automated weeklies)
//
// 3-per-24h per-recipient rate limit enforced via email_log.

import * as React from "react";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { cadenceIntervalDays, monthsBetween } from "@/lib/groups/reminder-cadence";
import { resolveEmailContent, renderOverrideBodyInLayout } from "@/lib/email/template-resolve";
import { sendEmail } from "@/lib/email/send";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import { safeAwait } from "@/lib/db/safe-mutation";
import { signUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { generateToken } from "@/lib/groups/invitation-token";
import { GroupReminder } from "@/emails/GroupReminder";
import type { BrandedLayoutProps } from "@/emails/BrandedLayout";

interface InvitationRow {
  id: string;
  invitee_email: string;
  invitee_name: string | null;
  last_email_sent_at: string | null;
  sailing_date: string;
  cruise_line: string;
  ship_name: string;
  coordinator_message: string | null;
  tenant_id: string;
  group_hero_image_url: string | null;
}

export const groupReminderCadence = inngest.createFunction(
  {
    id: "group-reminder-cadence",
    triggers: [{ cron: "0 8 * * *" }], // 08:00 UTC daily
  },
  async () => {
    const svc = createServiceRoleClient();
    const now = new Date();
    let sent = 0;
    let skipped = 0;

    // Fetch pending invitations joined with group details via a view-style query.
    // Supabase doesn't support cross-table JOIN in a simple .select; use two queries.
    const { data: pending, error: fetchErr } = await svc
      .from("invitations")
      .select("id,invitee_email,invitee_name,last_email_sent_at,group_id")
      .eq("rsvp_state", "pending")
      .is("token_revoked_at", null)
      .limit(500);

    if (fetchErr) {
      console.error("[group-reminder-cadence] fetch error:", fetchErr.message);
      return { sent, skipped };
    }

    const invitations = (pending ?? []) as { id: string; invitee_email: string; invitee_name: string | null; last_email_sent_at: string | null; group_id: string }[];
    if (invitations.length === 0) return { sent, skipped };

    // Fetch groups for all relevant group_ids.
    const groupIds = [...new Set(invitations.map((i) => i.group_id))];
    const { data: groups, error: groupErr } = await svc
      .from("groups")
      .select("id,sailing_date,cruise_line,ship_name,coordinator_message,hero_image_url,tenant_id,status")
      .in("id", groupIds);

    if (groupErr) {
      console.error("[group-reminder-cadence] group fetch error:", groupErr.message);
      return { sent, skipped };
    }

    const groupMap = new Map((groups ?? []).map((g: { id: string; sailing_date: string; cruise_line: string; ship_name: string; coordinator_message: string | null; hero_image_url: string | null; tenant_id: string; status: string }) => [g.id, g]));

    // #975 — tenant legal info + branding for the BrandedLayout wrapper
    // (CAN-SPAM footer: legal name, address, unsubscribe link). The pre-#975
    // reminder shipped bare HTML with no footer at all.
    const tenantIds = [...new Set([...groupMap.values()].map((g) => g.tenant_id))];
    const [{ data: tenantRows, error: tenantErr }, { data: brandingRows, error: brandingErr }] = await Promise.all([
      // #1190: the email_* / send-pattern / resend-key columns live on
      // tenant_branding, not tenants — read them from the branding row below.
      svc.from("tenants").select("id, legal_name, mailing_address").in("id", tenantIds),
      svc
        .from("tenant_branding")
        .select("tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name, email_from_domain, email_from_domain_verified_at")
        .in("tenant_id", tenantIds),
    ]);
    // A failed read here would silently send every reminder with the placeholder
    // legal name and an empty address — degrading the very CAN-SPAM footer this
    // path exists to provide. Throw so the Inngest run retries instead.
    if (tenantErr) throw new Error(`tenants.select failed: ${tenantErr.message}`);
    if (brandingErr) throw new Error(`tenant_branding.select failed: ${brandingErr.message}`);
    type TenantRow = {
      id: string;
      legal_name: string | null;
      mailing_address: string | null;
    };
    type BrandingRow = {
      tenant_id: string;
      logo_url: string | null;
      primary_color: string | null;
      secondary_color: string | null;
      accent_color: string | null;
      slogan: string | null;
      email_send_pattern: "platform_resend" | "tenant_resend";
      tenant_resend_api_key_encrypted: string | null;
      email_from_address: string | null;
      email_from_name: string | null;
      email_from_domain: string | null;
      email_from_domain_verified_at: string | null;
    };
    const tenantMap = new Map(((tenantRows ?? []) as TenantRow[]).map((t) => [t.id, t]));
    const brandingMap = new Map(((brandingRows ?? []) as BrandingRow[]).map((b) => [b.tenant_id, b]));
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";
    const { renderToStaticMarkup } = await import("react-dom/server");

    for (const inv of invitations) {
      const group = groupMap.get(inv.group_id);
      if (!group || group.status === "sailed" || group.status === "cancelled") continue;

      const sailDate = new Date(group.sailing_date);
      if (sailDate <= now) continue;

      const months = monthsBetween(now, sailDate);
      const intervalDays = cadenceIntervalDays(months);
      if (intervalDays === null) { skipped++; continue; }

      if (inv.last_email_sent_at) {
        const daysSinceLast = (now.getTime() - new Date(inv.last_email_sent_at).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLast < intervalDays) { skipped++; continue; }
      }

      // 3-per-24h rate limit. Uses §23.2 email_log schema (BP23 migration).
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const { data: recentLog } = await svc
        .from("email_log")
        .select("id")
        .eq("tenant_id", group.tenant_id)
        .eq("to_email", inv.invitee_email)
        .eq("email_category", "group_invitation")
        .gte("sent_at", windowStart.toISOString());
      if ((recentLog?.length ?? 0) >= 3) { skipped++; continue; }

      // #963 — tenant subject/body override → platform default. Fail loud
      // per-recipient: a failed override read or render skips this send
      // (logged), never falls back silently or sends an empty body.
      // #975 — both paths render inside BrandedLayout so every reminder
      // carries the tenant branding and the CAN-SPAM footer.
      const tenant = tenantMap.get(group.tenant_id);
      const branding = brandingMap.get(group.tenant_id);
      const unsubToken = signUnsubscribeToken({
        email: inv.invitee_email,
        tenant_id: group.tenant_id,
        category: "group_invitation",
      });
      const layout: Omit<BrandedLayoutProps, "children"> = {
        branding: {
          logo_url: branding?.logo_url ?? null,
          primary_color: branding?.primary_color ?? null,
          secondary_color: branding?.secondary_color ?? null,
          accent_color: branding?.accent_color ?? null,
          slogan: branding?.slogan ?? null,
        },
        tenant_legal_name: tenant?.legal_name ?? "Travel Agency",
        tenant_business_address: formatMailingAddress(tenant?.mailing_address),
        unsubscribe_url: `${baseUrl}/email/unsubscribe?token=${unsubToken}`,
      };

      let subject: string;
      let html: string;
      try {
        const inviteUrl = `${baseUrl}/group/invite/${generateToken(inv.id)}`;
        const resolved = await resolveEmailContent({
          db: svc,
          tenant_id: group.tenant_id,
          email_type: "group_reminder",
          variables: {
            invitee_name: inv.invitee_name ?? "there",
            cruise_line: group.cruise_line,
            ship_name: group.ship_name,
            sailing_date: group.sailing_date,
            coordinator_message: group.coordinator_message ?? "",
            invite_url: inviteUrl,
          },
        });
        subject = resolved.subject;
        html =
          resolved.overrideBodyText !== null
            ? await renderOverrideBodyInLayout(layout, resolved.overrideBodyText)
            : renderToStaticMarkup(
                React.createElement(GroupReminder, {
                  layout,
                  invitee_name: inv.invitee_name,
                  cruise_line: group.cruise_line,
                  ship_name: group.ship_name,
                  sailing_date: group.sailing_date,
                  coordinator_message: group.coordinator_message,
                  hero_image_url: group.hero_image_url,
                  invite_url: inviteUrl,
                }),
              );
      } catch (err) {
        console.error(
          `[group-reminder-cadence] template resolution failed for tenant=${group.tenant_id} invitation=${inv.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        skipped++;
        continue;
      }

      // Route through the shared helper so suppression (an unsubscribed or
      // bounced invitee is skipped), §16.4 tenant from-address resolution, and
      // the email_log write all apply. The 3-per-24h cadence guard above is the
      // rate limit; sendEmail's limiter is a no-op for the group_invitation
      // category, so there's no double-throttling.
      const result = await sendEmail({
        db: svc,
        tenant: {
          id: group.tenant_id,
          legal_name: tenant?.legal_name ?? "Travel Agency",
          mailing_address: tenant?.mailing_address ?? null,
          // #1190: email send config comes from tenant_branding.
          email_send_pattern: branding?.email_send_pattern ?? "platform_resend",
          tenant_resend_api_key_encrypted: branding?.tenant_resend_api_key_encrypted ?? null,
          email_from_address: branding?.email_from_address ?? null,
          email_from_name: branding?.email_from_name ?? null,
          email_from_domain: branding?.email_from_domain ?? null,
          email_from_domain_verified_at: branding?.email_from_domain_verified_at ?? null,
        },
        to: inv.invitee_email,
        subject,
        template_id: "group_reminder",
        category: "group_invitation",
        html,
        related_group_id: group.id,
        // #1580 — keyed on the invitation + calendar day so an Inngest
        // retry of this same cadence run doesn't double-send; a *new* day's
        // cadence run gets a fresh key and is expected to send again.
        idempotencyKey: `group_reminder:${inv.id}:${now.toISOString().slice(0, 10)}`,
      });

      if (result.status === "sent") {
        // Only stamp last_email_sent_at on a real send so the cadence interval
        // advances. Suppressed/rate-limited/failed leave it untouched.
        await safeAwait(
          svc.from("invitations").update({ last_email_sent_at: now.toISOString() }).eq("id", inv.id),
          "invitations.update.last_email_sent_at",
        );
        sent++;
      } else {
        skipped++;
      }
    }

    console.log(`[group-reminder-cadence] sent=${sent} skipped=${skipped}`);
    return { sent, skipped };
  },
);

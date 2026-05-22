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

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

function cadenceIntervalDays(monthsUntilSailing: number): number | null {
  if (monthsUntilSailing >= 24) return 42;
  if (monthsUntilSailing >= 12) return 30;
  if (monthsUntilSailing >= 6)  return 14;
  if (monthsUntilSailing >= 1)  return 7;
  return null;
}

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

      // 3-per-24h rate limit.
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const { data: recentLog } = await svc
        .from("email_log")
        .select("id")
        .eq("recipient_email", inv.invitee_email)
        .gte("sent_at", windowStart.toISOString());
      if ((recentLog?.length ?? 0) >= 3) { skipped++; continue; }

      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) { skipped++; continue; }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "trips@ai-travelconcierge.com",
          to: inv.invitee_email,
          subject: `Reminder: ${group.cruise_line} — ${group.ship_name} sailing ${group.sailing_date}`,
          html: `<p>Hi ${inv.invitee_name ?? "there"},</p><p>Friendly reminder about your group trip on <strong>${group.ship_name}</strong> (${group.cruise_line}) sailing <strong>${group.sailing_date}</strong>.</p>${group.coordinator_message ? `<blockquote>${group.coordinator_message}</blockquote>` : ""}`,
        }),
      });

      if (res.ok) {
        await Promise.all([
          svc.from("email_log").insert({ recipient_email: inv.invitee_email, template_name: "group_reminder", tenant_id: group.tenant_id }),
          svc.from("invitations").update({ last_email_sent_at: now.toISOString() }).eq("id", inv.id),
        ]);
        sent++;
      }
    }

    console.log(`[group-reminder-cadence] sent=${sent} skipped=${skipped}`);
    return { sent, skipped };
  },
);

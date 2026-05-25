// BP37 §37.3 — Reminder fire-up cron.
//
// Runs every minute; sweeps task_reminders WHERE remind_at <= NOW AND
// fired_at IS NULL. For 'in_app' reminders, just stamps fired (the CRM
// nav badge queries task_reminders for unread+unfired). For 'email',
// sends a templated email via Resend (assumes existing helper present).
//
// Snoozed tasks suppress their reminders per §37.3.3: a reminder whose
// remind_at < the task's snoozed_until is marked 'suppressed' instead
// of fired.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendTaskReminderEmail } from "@/lib/tasks/send-reminder-email";

const BATCH_LIMIT = 200;

export const taskRemindersFire = inngest.createFunction(
  {
    id: "task-reminders-fire",
    triggers: [{ cron: "* * * * *" }], // every minute
  },
  async () => {
    if (process.env.BP37_REMINDERS_DISABLED === "true") {
      return { skipped: true, reason: "BP37_REMINDERS_DISABLED=true" };
    }

    const svc = createServiceRoleClient();
    const nowIso = new Date().toISOString();

    const { data, error } = await svc
      .from("task_reminders")
      .select("id, tenant_id, task_id, channel, remind_at, tasks!inner(snoozed_until, assigned_to_user_id, status, title)")
      .is("fired_at", null)
      .lte("remind_at", nowIso)
      .limit(BATCH_LIMIT);
    if (error) return { error: error.message };

    type Row = {
      id: string;
      tenant_id: string;
      task_id: string;
      channel: "in_app" | "email";
      remind_at: string;
      tasks:
        | { snoozed_until: string | null; assigned_to_user_id: string | null; status: string; title: string }
        | { snoozed_until: string | null; assigned_to_user_id: string | null; status: string; title: string }[]
        | null;
    };

    const rows = (data ?? []) as Row[];
    let delivered = 0;
    let suppressed = 0;
    let failed = 0;

    for (const r of rows) {
      const t = Array.isArray(r.tasks) ? r.tasks[0] ?? null : r.tasks;
      // §37.3.3 — suppress reminders that fall inside a snooze window.
      const snoozed = t?.snoozed_until && Date.parse(r.remind_at) < Date.parse(t.snoozed_until);

      let status: "delivered" | "suppressed" | "failed";
      if (snoozed) {
        status = "suppressed";
      } else if (r.channel === "email") {
        // §37.3.2 — send through BP23 email infrastructure.
        const emailResult = await sendTaskReminderEmail({
          svc,
          task_id: r.task_id,
          tenant_id: r.tenant_id,
        });
        if (emailResult.status === "sent") status = "delivered";
        else if (emailResult.status === "suppressed") status = "suppressed";
        else status = "failed";
      } else {
        // in_app channel: cron just marks fired. The CRM nav badge reads
        // task_reminders WHERE fired_status='delivered' AND task is open.
        status = "delivered";
      }

      try {
        await svc
          .from("task_reminders")
          .update({ fired_at: new Date().toISOString(), fired_status: status })
          .eq("id", r.id);
        if (status === "delivered") delivered++;
        else if (status === "suppressed") suppressed++;
        else failed++;
      } catch (err) {
        failed++;
        console.error("[task-reminders-fire] mark failed:", err);
      }
    }

    return { processed: rows.length, delivered, suppressed, failed };
  },
);

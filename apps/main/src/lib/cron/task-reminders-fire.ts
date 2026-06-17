// BP37 §37.3 — Reminder fire-up cron core logic.
// Runs every minute via Vercel cron (/api/cron/task-reminders-fire).
// Sweeps task_reminders WHERE remind_at <= NOW AND fired_at IS NULL.
// For 'in_app' reminders, stamps fired. For 'email', sends via Resend.
// Snoozed tasks suppress their reminders (§37.3.3).
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendTaskReminderEmail } from "@/lib/tasks/send-reminder-email";
import { safeAwait } from "@/lib/db/safe-mutation";

const BATCH_LIMIT = 200;
// Drain loop budget — stop fetching new batches after 50s to leave
// headroom before the 1-min cron re-fires. (#900)
const TIME_BUDGET_MS = 50_000;

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

export async function runTaskRemindersFire() {
  if (process.env.BP37_REMINDERS_DISABLED === "true") {
    return { skipped: true, reason: "BP37_REMINDERS_DISABLED=true" };
  }

  const svc = createServiceRoleClient();
  const nowIso = new Date().toISOString();

  let processed = 0;
  let delivered = 0;
  let suppressed = 0;
  let failed = 0;
  let batches = 0;
  const start = Date.now();

  // #900: drain loop — keep fetching batches until the backlog is empty
  // or the time budget is exhausted. fired_at IS NULL makes re-fetching
  // safe: each pass only sees rows not yet stamped by this or a prior run.
  while (Date.now() - start < TIME_BUDGET_MS) {
    const { data, error } = await svc
      .from("task_reminders")
      .select("id, tenant_id, task_id, channel, remind_at, tasks!inner(snoozed_until, assigned_to_user_id, status, title)")
      .is("fired_at", null)
      .lte("remind_at", nowIso)
      .limit(BATCH_LIMIT);
    if (error) throw new Error(`task_reminders select failed: ${error.message}`);

    const rows = (data ?? []) as Row[];
    batches++;

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
        await safeAwait(svc
          .from("task_reminders")
          .update({ fired_at: new Date().toISOString(), fired_status: status })
          .eq("id", r.id), "task_reminders.update");
        if (status === "delivered") delivered++;
        else if (status === "suppressed") suppressed++;
        else failed++;
      } catch (err) {
        failed++;
        console.error("[task-reminders-fire] mark failed:", err);
      }
    }

    processed += rows.length;

    // Batch came back short — backlog is drained, no point re-querying.
    if (rows.length < BATCH_LIMIT) break;
  }

  return { processed, delivered, suppressed, failed, batches };
}

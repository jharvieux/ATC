// BP37 §37.4.2 — Per-step task materializer.
//
// Consumes task_sequence.step_scheduled (emitted by sequence-engine with
// future ts for delay). Reads the snapshot, looks at the live record's
// current status for skip_if_status, materializes the task + any
// reminders if not skipped.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { applyTemplate, type SubstitutionContext } from "@/lib/tasks/template";
import { safeAwait } from "@/lib/db/safe-mutation";

type SnapshotStep = {
  step_index: number;
  offset_days: number;
  offset_hours: number;
  task_title_template: string;
  task_description_template: string | null;
  task_type: string;
  task_priority: string;
  reminder_offsets_minutes: number[] | null;
  skip_if_status: string[] | null;
};

type RunRow = {
  id: string;
  tenant_id: string;
  sequence_id: string;
  status: string;
  contact_id: string | null;
  quote_id: string | null;
  booking_id: string | null;
  steps_snapshot: SnapshotStep[];
};

export const taskSequenceStepFire = inngest.createFunction(
  {
    id: "task-sequence-step-fire",
    triggers: [{ event: "task_sequence.step_scheduled" }],
    retries: 3,
  },
  async ({ event }) => {
    const { tenant_id, sequence_run_id, step_index } = event.data;
    const svc = createServiceRoleClient();

    const { data: runData, error: runErr } = await svc
      .from("task_sequence_runs")
      .select("id, tenant_id, sequence_id, status, contact_id, quote_id, booking_id, steps_snapshot")
      .eq("id", sequence_run_id)
      .maybeSingle();
    if (runErr || !runData) return { skipped: true, reason: `run_not_found:${runErr?.message ?? ""}` };

    const run = runData as RunRow;
    if (run.tenant_id !== tenant_id) return { skipped: true, reason: "tenant_mismatch" };
    if (run.status !== "active") return { skipped: true, reason: `run_not_active:${run.status}` };

    const step = run.steps_snapshot.find((s) => s.step_index === step_index);
    if (!step) return { skipped: true, reason: `step_not_in_snapshot:${step_index}` };

    // Build substitution context + check skip_if_status against live record.
    const ctx: SubstitutionContext = {};
    let liveStatus: string | null = null;

    if (run.contact_id) {
      const { data } = await svc
        .from("contacts")
        .select("first_name, last_name, pipeline_stage_key")
        .eq("id", run.contact_id)
        .maybeSingle();
      if (data) {
        const c = data as { first_name: string | null; last_name: string | null; pipeline_stage_key: string | null };
        ctx.contact = { first_name: c.first_name, last_name: c.last_name };
        liveStatus = c.pipeline_stage_key;
      }
    } else if (run.quote_id) {
      const { data } = await svc
        .from("quotes")
        .select("status, cruise_line, sailing_date, contact_id")
        .eq("id", run.quote_id)
        .maybeSingle();
      if (data) {
        const q = data as { status: string; cruise_line: string | null; sailing_date: string | null; contact_id: string };
        ctx.quote = { cruise_line: q.cruise_line, sailing_date: q.sailing_date };
        liveStatus = q.status;
        const { data: c } = await svc
          .from("contacts")
          .select("first_name, last_name")
          .eq("id", q.contact_id)
          .maybeSingle();
        if (c) ctx.contact = c as { first_name: string | null; last_name: string | null };
      }
    } else if (run.booking_id) {
      const { data } = await svc
        .from("bookings")
        .select("status, cruise_line, sailing_date, primary_contact_id")
        .eq("id", run.booking_id)
        .maybeSingle();
      if (data) {
        const b = data as { status: string; cruise_line: string | null; sailing_date: string | null; primary_contact_id: string | null };
        ctx.booking = { cruise_line: b.cruise_line, sailing_date: b.sailing_date };
        liveStatus = b.status;
        if (b.sailing_date) {
          const days = Math.round((Date.parse(b.sailing_date) - Date.now()) / (24 * 60 * 60 * 1000));
          ctx.days_until_sailing = days;
        }
        if (b.primary_contact_id) {
          const { data: c } = await svc
            .from("contacts")
            .select("first_name, last_name")
            .eq("id", b.primary_contact_id)
            .maybeSingle();
          if (c) ctx.contact = c as { first_name: string | null; last_name: string | null };
        }
      }
    }

    if (step.skip_if_status && liveStatus && step.skip_if_status.includes(liveStatus)) {
      return { skipped: true, reason: `skip_if_status_match:${liveStatus}` };
    }

    const title = applyTemplate(step.task_title_template, ctx);
    const description = step.task_description_template
      ? applyTemplate(step.task_description_template, ctx)
      : null;

    const recordRef = run.contact_id
      ? { contact_id: run.contact_id }
      : run.quote_id
      ? { quote_id: run.quote_id }
      : { booking_id: run.booking_id! };

    const due_at = new Date().toISOString(); // step delay is already applied via Inngest ts

    const { data: taskRow, error: taskErr } = await svc
      .from("tasks")
      .insert({
        tenant_id,
        ...recordRef,
        title,
        description,
        task_type: step.task_type,
        priority: step.task_priority,
        due_at,
        origin: "sequence",
        sequence_run_id,
        sequence_step_index: step_index,
      })
      .select("id")
      .single();
    if (taskErr || !taskRow) {
      console.error("[task-sequence-step-fire] task insert failed:", taskErr?.message);
      return { error: taskErr?.message ?? "insert_failed" };
    }

    const taskId = (taskRow as { id: string }).id;

    // Reminders.
    if (step.reminder_offsets_minutes && step.reminder_offsets_minutes.length > 0) {
      const dueMs = Date.parse(due_at);
      const reminders = step.reminder_offsets_minutes.map((minutes) => ({
        tenant_id,
        task_id: taskId,
        remind_at: new Date(dueMs - minutes * 60 * 1000).toISOString(),
        channel: "in_app" as const,
      }));
      await safeAwait(svc.from("task_reminders").insert(reminders), "task_reminders.insert");
    }

    return { ok: true, task_id: taskId };
  },
);

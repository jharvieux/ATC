// BP37 §37.4.2 — Sequence trigger.
//
// Called from CRM pipeline transitions when a new event happens
// (lead_created, quote_sent, etc.). Finds active sequences matching the
// trigger, creates a task_sequence_runs row with a steps_snapshot,
// emits one Inngest delayed event per step.
//
// Status: the engine is complete and downstream task-sequence-step-fire
// Inngest job consumes its emitted events. The CRM-side TRIGGER call
// sites (contact create, quote send/accept, booking create/confirm)
// call this via triggerMatchingSequences.
//
// §37.10 tier gate: sequences are unavailable to the byo_research tier.
// The gate is enforced here in the firing path (fail-closed) so every
// trigger call site is covered by construction.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { assertSequencesAvailable } from "@/lib/tasks/tier-gate";

export type TriggerRecordRef =
  | { contact_id: string }
  | { quote_id: string }
  | { booking_id: string };

export type TriggerEvent =
  | "lead_created"
  | "quote_sent"
  | "quote_accepted"
  | "booking_created"
  | "booking_confirmed"
  | "pre_sail_60d"
  | "post_sail_7d"
  | "manual";

type StepRow = {
  id: string;
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

export async function triggerMatchingSequences(args: {
  tenant_id: string;
  trigger: TriggerEvent;
  record: TriggerRecordRef;
  triggered_by_user_id?: string | null;
  svc: Pick<SupabaseClient, "from">;
}): Promise<{ runs_started: number }> {
  const { tenant_id, trigger, record, triggered_by_user_id, svc } = args;

  const gate = await assertSequencesAvailable(tenant_id, svc);
  if (!gate.ok) return { runs_started: 0 };

  const { data: sequences, error } = await svc
    .from("task_sequences")
    .select("id, applies_to_record")
    .eq("tenant_id", tenant_id)
    .eq("is_active", true)
    .eq("trigger_event", trigger);
  if (error) throw new Error(`sequence_lookup_failed:${error.message}`);

  let runsStarted = 0;
  for (const seq of (sequences ?? []) as Array<{ id: string; applies_to_record: string }>) {
    // Pull steps + create run + emit step events.
    const { data: stepRows } = await svc
      .from("task_sequence_steps")
      .select(
        "id, step_index, offset_days, offset_hours, task_title_template, task_description_template, task_type, task_priority, reminder_offsets_minutes, skip_if_status",
      )
      .eq("sequence_id", seq.id)
      .order("step_index", { ascending: true });

    const steps = (stepRows ?? []) as StepRow[];
    if (steps.length === 0) continue;

    const { data: runRow, error: runErr } = await svc
      .from("task_sequence_runs")
      .insert({
        tenant_id,
        sequence_id: seq.id,
        ...record,
        triggered_by_user_id: triggered_by_user_id ?? null,
        steps_snapshot: steps,
      })
      .select("id")
      .single();
    if (runErr || !runRow) {
      console.error("[sequence-engine] run insert failed:", runErr?.message);
      continue;
    }

    const runId = (runRow as { id: string }).id;
    const now = Date.now();
    for (const step of steps) {
      const fireAtMs = now + (step.offset_days * 24 * 60 + step.offset_hours * 60) * 60 * 1000;
      await inngest.send({
        name: "task_sequence.step_scheduled",
        data: { tenant_id, sequence_run_id: runId, step_index: step.step_index },
        ts: Math.max(now, fireAtMs),
      });
    }
    runsStarted++;
  }

  return { runs_started: runsStarted };
}

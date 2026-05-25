// BP37 §37.5 — Helpers for system-task generator crons.
//
// All system tasks have origin='system' + a stable origin_reference so
// the UNIQUE partial index on (tenant_id, origin, origin_reference)
// prevents duplicates (§37.11). Each generator passes the matched
// record's id as part of the origin_reference to keep it stable across
// daily runs.

import type { SupabaseClient } from "@supabase/supabase-js";

export type SystemTaskInput = {
  tenant_id: string;
  origin_reference: string; // unique per (tenant, generator, target record)
  title: string;
  description?: string | null;
  task_type: "call" | "email" | "text" | "meeting" | "follow_up" | "review" | "document" | "custom";
  priority?: "low" | "normal" | "high" | "urgent";
  due_at: string | null;
  contact_id?: string | null;
  quote_id?: string | null;
  booking_id?: string | null;
};

/** Inserts a system task, swallowing the dup-key error from the UNIQUE
 *  partial index (§37.11). Returns true if a new row was inserted. */
export async function upsertSystemTask(
  svc: Pick<SupabaseClient, "from">,
  input: SystemTaskInput,
): Promise<boolean> {
  const { error } = await svc.from("tasks").insert({
    tenant_id: input.tenant_id,
    contact_id: input.contact_id ?? null,
    quote_id: input.quote_id ?? null,
    booking_id: input.booking_id ?? null,
    title: input.title,
    description: input.description ?? null,
    task_type: input.task_type,
    priority: input.priority ?? "normal",
    due_at: input.due_at,
    origin: "system",
    origin_reference: input.origin_reference,
  });
  if (error) {
    // 23505 = unique_violation. We're using the UNIQUE partial index to
    // dedupe across runs; collision = the task already exists, no-op.
    if (error.code === "23505") return false;
    console.warn("[system-task-helpers] insert failed:", error.message, error.code);
    return false;
  }
  return true;
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

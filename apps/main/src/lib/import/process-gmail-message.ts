// BP34 §34.2 — Gmail message → import pipeline glue.
//
// Called by the Pub/Sub webhook after a fresh gmail_inbound_messages
// row has been persisted (subject, body, etc. already populated). This
// helper:
//
//   1. Runs the §34.2.2 IMPORT-trigger detector on subject + body.
//   2. If it qualifies → inserts an import_queue row at
//      pending_classification and emits import.queued.
//   3. Stamps `qualifies_for_import` + `triggered_at` on the gmail row.
//
// Returns a structured result so the webhook can log per-message
// disposition (qualified vs. skipped).

import type { SupabaseClient } from "@supabase/supabase-js";
import { qualifiesForImport } from "./trigger-regex";
import { inngest } from "@/inngest/client";

export type GmailProcessResult =
  | { qualified: true; import_queue_id: string }
  | { qualified: false; reason: "no_trigger_word" | "empty_body" };

export async function processGmailInboundMessage(args: {
  tenant_id: string;
  message_id: string;
  subject: string;
  body_text: string;
  svc: Pick<SupabaseClient, "from">;
}): Promise<GmailProcessResult> {
  const { tenant_id, message_id, subject, body_text, svc } = args;

  if (!subject && !body_text) {
    await svc
      .from("gmail_inbound_messages")
      .update({ qualifies_for_import: false })
      .eq("message_id", message_id);
    return { qualified: false, reason: "empty_body" };
  }

  if (!qualifiesForImport(subject, body_text)) {
    await svc
      .from("gmail_inbound_messages")
      .update({ qualifies_for_import: false })
      .eq("message_id", message_id);
    return { qualified: false, reason: "no_trigger_word" };
  }

  // Insert the queue row at pending_classification; source_ref is the
  // Gmail message_id so the pipeline's resolveText can look the body up.
  const { data: inserted, error: insErr } = await svc
    .from("import_queue")
    .insert({
      tenant_id,
      import_path: "email",
      source_ref: message_id,
      status: "pending_classification",
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    throw new Error(`gmail_queue_insert_failed: ${insErr?.message ?? "unknown"}`);
  }
  const import_queue_id = (inserted as { id: string }).id;

  await svc
    .from("gmail_inbound_messages")
    .update({
      qualifies_for_import: true,
      triggered_at: new Date().toISOString(),
    })
    .eq("message_id", message_id);

  await inngest.send({
    name: "import.queued",
    data: { tenant_id, import_queue_id },
  });

  return { qualified: true, import_queue_id };
}

// §27.12 — Enqueue a unit of work for batch processing.
//
// Writes one row to ai_batch_requests with status='pending'. The flush
// cron (per-purpose) will collect pending rows, submit them as one
// Anthropic batch, and update each row's batch_job_id + status.
//
// Producers thread their downstream context via caller_metadata —
// booking_id+phase for precruise, conversation_id for memory-extract,
// addendum_id for persona screen, etc. The completion event re-surfaces
// caller_metadata so the consumer can do the right side effect.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import type { BatchablePurpose } from "./types";

export interface EnqueueArgs {
  tenant_id: string;
  purpose: BatchablePurpose;
  /** Anthropic message-create params. Model defaults are caller's choice. */
  request_params: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    // #2009 — optional structured-output constraint; stored verbatim in the
    // JSONB column and forwarded by flush → submitAnthropicBatch.
    output_config?: { format: { type: "json_schema"; schema: Record<string, unknown> } };
  };
  /** Producer's downstream context. Read back on completion. */
  caller_metadata?: Record<string, unknown>;
  /** Service-role client; enqueue is purely backend. */
  db: SupabaseClient;
}

export interface EnqueueResult {
  request_id: string;
  enqueued_at: string;
}

export async function enqueueBatchRequest(args: EnqueueArgs): Promise<EnqueueResult> {
  if (args.request_params.messages.length === 0) {
    throw new Error("enqueueBatchRequest: messages array is empty");
  }
  if (args.request_params.max_tokens <= 0) {
    throw new Error("enqueueBatchRequest: max_tokens must be positive");
  }

  const row = await safeAwait(
    args.db
      .from("ai_batch_requests")
      .insert({
        tenant_id: args.tenant_id,
        purpose: args.purpose,
        status: "pending",
        // custom_id = the generated id of this row. We can't pre-populate
        // a UUID in the insert (Supabase DEFAULT generates it), so insert
        // a placeholder + update on the same row after we know the id.
        // Use the DB's gen_random_uuid for both id AND custom_id by
        // setting custom_id = id in a follow-up update. Cheaper: use
        // crypto.randomUUID() in JS for both at insert time.
        custom_id: crypto.randomUUID(),
        request_params: args.request_params,
        caller_metadata: args.caller_metadata ?? null,
      })
      .select("id, custom_id, created_at")
      .single(),
    "ai_batch_requests.insert",
  );

  // After insert: re-set custom_id to the row's own id so the flush
  // step can use a single field for both keys. Done as a follow-up to
  // keep the row creation simple.
  const r = row as unknown as { id: string; custom_id: string; created_at: string };
  await safeAwait(
    args.db
      .from("ai_batch_requests")
      .update({ custom_id: r.id })
      .eq("id", r.id)
      .eq("tenant_id", args.tenant_id),
    "ai_batch_requests.update.custom_id",
  );

  return { request_id: r.id, enqueued_at: r.created_at };
}

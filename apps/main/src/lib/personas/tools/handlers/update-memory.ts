// §9.6 / §11.4 — update_memory handler.
//
// Writes a fact / preference / interest to customer_memories. Per the
// spec the AI must NOT auto-write memory without a consent gate; the
// real gate lives in the AI-extracted-memory pipeline (post-call review
// queue). For tool-use, the AI is making the call explicitly in
// response to a customer statement — treat it as "AI proposed write,
// not yet customer-confirmed" — write to the queue with status
// 'pending_customer_review' so the customer sees it in their memory
// timeline on next refresh.
//
// Idempotency: writes append-only to memory_extractions (the audit /
// review queue), not the canonical customer_memories aggregate. So
// duplicate calls just add duplicate rows; the dedup is at the
// reviewer-UI level. Safe to retry.

import { z } from "zod";
import type { ToolDispatchContext, ToolResult } from "../dispatch";
import { safeAwait } from "@/lib/db/safe-mutation";

const InputSchema = z.object({
  memory_type: z.enum(["preference", "fact", "constraint", "interest"]),
  content: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1).default(0.7),
});

export async function updateMemory(
  rawInput: Record<string, unknown>,
  dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      content: JSON.stringify({ error: "invalid_input", detail: parsed.error.message }),
      was_mutating: false,
    };
  }
  const { memory_type, content, confidence } = parsed.data;

  if (!dispatchCtx.contact_id) {
    return {
      content: JSON.stringify({
        error: "no_customer_in_session",
        message:
          "Can't store memory without an identified customer. Ask their name/email first.",
      }),
      was_mutating: false,
    };
  }

  // §11.4 — write to the proposed-memory queue (memory_extractions),
  // NOT directly to customer_memories. Customer sees the proposed
  // entry on their next /settings/memory load and can confirm or
  // reject. This is the consent gate the spec calls for.
  const inserted = await safeAwait(
    dispatchCtx.db
      .from("memory_extractions")
      .insert({
        tenant_id: dispatchCtx.ctx.tenant_id,
        contact_id: dispatchCtx.contact_id,
        conversation_id: dispatchCtx.conversation_id,
        memory_type,
        content,
        confidence,
        source: "ai_tool_call",
        status: "pending_customer_review",
      })
      .select("id")
      .single(),
    "memory_extractions.insert",
  );

  return {
    content: JSON.stringify({
      ok: true,
      memory_extraction_id: (inserted as unknown as { id?: string } | null)?.id ?? null,
      message:
        "Memory captured (pending customer review on their next visit). Acknowledge but don't promise it'll persist exactly — the customer controls their memory.",
      memory_type,
      confidence,
    }),
    was_mutating: true,
  };
}

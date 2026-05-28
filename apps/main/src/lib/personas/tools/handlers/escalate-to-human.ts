// §9.6 — escalate_to_human handler.
//
// Opens a row in escalation_topics. The supervisor dashboard surfaces
// these to platform staff; tenant staff see them in the per-conversation
// thread. NOT idempotent — calling twice creates two escalations. The
// LLM should only call this once per turn; the regen loop is harmless
// because the supervisor's regen instruction would override.

import { z } from "zod";
import type { ToolDispatchContext, ToolResult } from "../dispatch";
import { safeAwait } from "@/lib/db/safe-mutation";

const InputSchema = z.object({
  reason: z.enum([
    "customer_requested",
    "emergency",
    "complaint_unresolved",
    "complex_booking",
    "regulatory_requirement",
    "other",
  ]),
  summary: z.string().min(1).max(2000),
  urgency: z.enum(["normal", "high", "emergency"]).default("normal"),
});

export async function escalateToHuman(
  rawInput: Record<string, unknown>,
  dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      content: JSON.stringify({
        error: "invalid_input",
        detail: parsed.error.message,
      }),
      was_mutating: false,
    };
  }
  const { reason, summary, urgency } = parsed.data;

  await safeAwait(
    dispatchCtx.db.from("escalation_topics").insert({
      tenant_id: dispatchCtx.ctx.tenant_id,
      conversation_id: dispatchCtx.conversation_id,
      topic_summary: summary,
      topic_tags: [reason, urgency],
      status: "open",
      initiated_by: "supervisor", // the AI persona initiated; closest existing enum value
      initiated_reason: reason,
    }),
    "escalation_topics.insert",
  );

  return {
    content: JSON.stringify({
      ok: true,
      message:
        "Escalation opened. A human travel coordinator will follow up. Tell the customer their request has been escalated and they'll hear back soon.",
      reason,
      urgency,
    }),
    was_mutating: true,
  };
}

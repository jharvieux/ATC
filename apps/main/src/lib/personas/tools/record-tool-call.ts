// §9.6 — Audit write for the tool dispatcher.
//
// One row per dispatched tool call into `ai_tool_calls`. Failure to write
// the audit row MUST NOT abort the tool dispatch (the LLM is mid-turn and
// the user is waiting) — we log the error and continue. This is the only
// place the dispatch code calls the audit table.
//
// Result content is best-effort parsed as JSON. Tool handlers always
// return JSON-stringified content today, but if the format ever drifts
// to a raw string, the audit row stores it as a JSONB string so the
// column type stays consistent.

import { safeAwait } from "@/lib/db/safe-mutation";
import type { ToolDispatchContext, ToolResult } from "./dispatch";

export interface RecordToolCallInput {
  dispatchCtx: ToolDispatchContext;
  tool_name: string;
  input: Record<string, unknown>;
  result: ToolResult;
  duration_ms: number;
  error_text?: string;
}

export async function recordToolCall(args: RecordToolCallInput): Promise<void> {
  const { dispatchCtx, tool_name, input, result, duration_ms, error_text } = args;

  // Parse the result.content if it looks like JSON; otherwise store as
  // a JSONB string. The column type is JSONB so either is accepted.
  let result_json: unknown = result.content;
  try {
    result_json = JSON.parse(result.content);
  } catch {
    // not JSON — store as-is
  }

  try {
    await safeAwait(
      dispatchCtx.db.from("ai_tool_calls").insert({
        tenant_id: dispatchCtx.ctx.tenant_id,
        conversation_id: dispatchCtx.conversation_id,
        tool_name,
        tool_use_id: dispatchCtx.tool_use_id ?? null,
        input_json: input,
        result_json,
        was_mutating: result.was_mutating,
        error_text: error_text ?? null,
        duration_ms,
      }),
      "ai_tool_calls.insert",
    );
  } catch (err) {
    // Audit write must not block the dispatch. Log loud so ops sees it.
    console.error(
      "[ai_tool_calls] audit insert failed tenant=%s tool=%s: %s",
      dispatchCtx.ctx.tenant_id,
      tool_name,
      err instanceof Error ? err.message : String(err),
    );
  }
}

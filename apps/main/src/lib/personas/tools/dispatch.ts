// §9.6 — Tool-use dispatcher.
//
// Maps an Anthropic tool_use block (name + input) to the right
// handler, executes it, and returns a tool_result string the LLM can
// consume on the follow-up call. Each handler is tenant-scoped via the
// passed TenantContext + service-role client.
//
// IMPORTANT: tool handlers can mutate DB state (write a memory, open
// an escalation, etc.). They MUST be idempotent or guarded by the
// caller — the AI may decide to call the same tool twice in one turn
// and the regen loop may re-issue tool calls. Each handler documents
// its idempotency story.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/db/tenant-context";
import { escalateToHuman } from "./handlers/escalate-to-human";
import { getCustomerContext } from "./handlers/get-customer-context";
import { updateMemory } from "./handlers/update-memory";
import { searchHostInventory } from "./handlers/search-host-inventory";
import { generateQuote } from "./handlers/generate-quote";
import { collectBookingDetails } from "./handlers/collect-booking-details";

export interface ToolDispatchContext {
  ctx: TenantContext;
  /** Service-role client. Handlers are tenant-scoped via ctx.tenant_id. */
  db: SupabaseClient;
  /** Current conversation; many tools need it to anchor side-effects. */
  conversation_id: string;
  /** Optional contact id for the current customer (from CRM lookup). */
  contact_id?: string | null;
}

export interface ToolResult {
  /** Stringified payload returned to the LLM as tool_result content. */
  content: string;
  /** True if the handler mutated state (used by audit / observability). */
  was_mutating: boolean;
}

const HANDLERS = new Map<
  string,
  (input: Record<string, unknown>, dispatchCtx: ToolDispatchContext) => Promise<ToolResult>
>([
  ["escalate_to_human", escalateToHuman],
  ["get_customer_context", getCustomerContext],
  ["update_memory", updateMemory],
  ["search_host_inventory", searchHostInventory],
  ["generate_quote", generateQuote],
  ["collect_booking_details", collectBookingDetails],
]);

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  const handler = HANDLERS.get(name);
  if (!handler) {
    return {
      content: JSON.stringify({
        error: "unknown_tool",
        tool_name: name,
        available_tools: Array.from(HANDLERS.keys()),
      }),
      was_mutating: false,
    };
  }
  try {
    return await handler(input, dispatchCtx);
  } catch (err) {
    // A handler error becomes a tool_result the LLM can reason about
    // (e.g., "the system can't reach the host adapter — apologize and
    // offer to email the client back"). Throwing here would abort the
    // whole turn which is worse UX.
    return {
      content: JSON.stringify({
        error: "tool_handler_failed",
        tool_name: name,
        detail: err instanceof Error ? err.message : String(err),
      }),
      was_mutating: false,
    };
  }
}

/** Tool names known to the dispatcher (introspection for tests + admin). */
export function listKnownTools(): string[] {
  return Array.from(HANDLERS.keys());
}

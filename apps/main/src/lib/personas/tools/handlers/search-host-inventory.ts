// §9.6 — search_host_inventory handler.
//
// PLACEHOLDER: real host-adapter wiring lives in BP14. Most adapters
// today are platform-fallback only — the actual search-by-criteria API
// on the real host adapters isn't implemented. This handler returns a
// structured "not yet available" result so the LLM gracefully offers
// to escalate or wait, rather than hallucinating inventory.

import type { ToolDispatchContext, ToolResult } from "../dispatch";

export async function searchHostInventory(
  _rawInput: Record<string, unknown>,
  _dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  return {
    content: JSON.stringify({
      error: "not_implemented",
      message:
        "Real-time host inventory search isn't connected yet. Tell the customer you can pass their search criteria to an agent who'll send a curated list of options within a day — or offer to escalate to a human agent now if it's urgent.",
      can_fall_back_to: "escalate_to_human",
    }),
    was_mutating: false,
  };
}

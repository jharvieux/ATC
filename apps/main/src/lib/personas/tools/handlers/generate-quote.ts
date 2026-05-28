// §9.6 — generate_quote handler.
//
// PLACEHOLDER: real quote generation involves the quotes + quote_options
// tables, pricing logic, commission lookups, and PDF rendering — all
// of which are explicitly tenant-agent workflows. Letting the AI auto-
// generate quotes without agent oversight conflicts with §38's "agent
// owns pricing" rule. This handler returns a structured nudge directing
// the AI to instead capture the customer's intent and hand off.

import type { ToolDispatchContext, ToolResult } from "../dispatch";

export async function generateQuote(
  _rawInput: Record<string, unknown>,
  _dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  return {
    content: JSON.stringify({
      error: "not_implemented",
      message:
        "Customer-facing AI cannot generate quotes directly — quotes require agent pricing review per §38. Capture the customer's interest (cabin tier, ports of interest, dates, party size) and tell them you'll have an agent send a personalized quote.",
      can_fall_back_to: "escalate_to_human",
    }),
    was_mutating: false,
  };
}

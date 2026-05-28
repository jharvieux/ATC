// §9.6 — collect_booking_details handler.
//
// PLACEHOLDER: real booking submission goes through /api/bookings/[id]/submit
// which holds the host-adapter CAS lock + commission math. Letting the AI
// directly write booking_passengers + flip status sidesteps the agent
// confirmation flow required by §20.4. This handler returns a structured
// nudge to keep the customer on the on-page booking flow + escalate.

import type { ToolDispatchContext, ToolResult } from "../dispatch";

export async function collectBookingDetails(
  _rawInput: Record<string, unknown>,
  _dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  return {
    content: JSON.stringify({
      error: "not_implemented",
      message:
        "Customer-facing AI cannot submit bookings directly — that's the agent's confirmation step per §20.4. Direct the customer to the on-page booking flow (/booking/flow/[id]) or escalate to a human agent if they're ready to commit.",
      can_fall_back_to: "escalate_to_human",
    }),
    was_mutating: false,
  };
}

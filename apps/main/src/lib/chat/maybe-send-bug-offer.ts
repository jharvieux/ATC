// #1759/#1781 — pre-LLM bug-intent check, extracted verbatim from handleChat.
//
// BP32 §32.10.1 — surfaces an offer for the customer to file a bug; the
// regular chat flow still runs underneath so the customer gets a normal
// response even if they ignore the offer. Gated by
// PHASE_2_CUSTOMER_BUG_FLOW_ENABLED inside detectBugIntent (#1190 removed
// the per-tenant tenant_settings opt-out).
// #902: customer-facing offer only — TA bug reporting lives in the help
// flows, not as a chat interrupt.

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectBugIntent } from "@/lib/help-ai/bug-intent-recognizer";
import type { ChatAudience } from "@/lib/personas/build-system-prompt";

export async function maybeSendBugOffer(args: {
  audience: ChatAudience;
  userMessage: string;
  svc: SupabaseClient;
  send: (ev: { type: "bug_offer"; message: string; matched_phrase: string }) => Promise<void>;
}): Promise<void> {
  const { audience, userMessage, svc, send } = args;
  try {
    const bug = audience === "customer"
      ? await detectBugIntent({ message: userMessage, db: svc })
      : { triggered: false as const, matched_phrase: null, offer_message: null };
    if (bug.triggered && bug.matched_phrase && bug.offer_message) {
      await send({
        type: "bug_offer",
        message: bug.offer_message,
        matched_phrase: bug.matched_phrase,
      });
    }
  } catch (err) {
    // Non-fatal: the recognizer is best-effort. Log + continue.
    console.warn("[chat] bug-intent recognizer failed:", String(err));
  }
}

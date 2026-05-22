// §10.2 tone_drift check — lexical sub-check REAL; heuristic sub-check STUB
//
// The lexical sub-check matches against the platform's slur/hate-speech deny-list
// stored in platform_settings.supervisor_slur_deny_list (per §24.5).
// The list is seeded empty; operators populate it before opening to tenants.
//
// Auto-escalation rule: 3 consecutive critical hits on this check (tracked in
// conversations.supervisor_slur_consecutive_count) → auto-open an escalation_topics
// row with initiated_by = 'supervisor'. The consecutive counter resets on any
// clean (non-critical) message.
//
// The heuristic sub-check (tone-topic mismatch, excessive profanity, sycophancy)
// TODO(§21.10): implement in Part 5. Returns info for now.
//
// Callers must supply the deny list from platform_settings — it is not read
// inside this function to keep the check pure and testable.

import type { CheckInput, SupervisorFinding } from "../types";

export type ToneDriftInput = {
  candidate_response: string;
  retrieved_chunks?: unknown[] | undefined;
  slurDenyList: string[];
};

export function checkToneDrift(input: ToneDriftInput): SupervisorFinding {
  // Lexical sub-check: deterministic match against deny list
  const lowerResponse = input.candidate_response.toLowerCase();
  for (const term of input.slurDenyList) {
    if (term.length > 0 && lowerResponse.includes(term.toLowerCase())) {
      return {
        check: "tone_drift",
        severity: "critical",
        details: `Slur/hate-speech deny-list match detected`,
      };
    }
  }

  // Heuristic sub-check: TODO(§21.10) — stub pass
  return {
    check: "tone_drift",
    severity: "info",
    details: "pass (lexical clean; heuristic stub)",
  };
}

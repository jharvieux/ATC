// §10.2 persona_drift check — STUB
// TODO(§21.10): real implementation in Part 5 hallucination defense work.
// Full implementation: compare response voice/style against persona base
// block; flag if response reads as a different persona or breaks character.

import type { CheckInput, SupervisorFinding } from "../types";

export function checkPersonaDrift(input: CheckInput): SupervisorFinding {
  void input;
  return {
    check: "persona_drift",
    severity: "info",
    details: "pass (stub)",
  };
}

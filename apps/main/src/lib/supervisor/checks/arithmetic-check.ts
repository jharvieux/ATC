// §10.2 arithmetic_check — STUB
// TODO(§21.10): real implementation in Part 5 hallucination defense work.
// Full implementation: extract any numeric calculations or price aggregations
// from the response and re-verify them deterministically.

import type { CheckInput, SupervisorFinding } from "../types";

export function checkArithmetic(input: CheckInput): SupervisorFinding {
  void input;
  return {
    check: "arithmetic_check",
    severity: "info",
    details: "pass (stub)",
  };
}

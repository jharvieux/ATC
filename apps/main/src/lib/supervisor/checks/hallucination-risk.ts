// §10.2 hallucination_risk check — STUB
// TODO(§21.10): real implementation in Part 5 hallucination defense work.
// Full implementation: extract factual claims from candidate_response,
// verify each claim against retrieved_chunks, flag unverifiable claims.

import type { CheckInput, SupervisorFinding } from "../types";

export function checkHallucinationRisk(input: CheckInput): SupervisorFinding {
  void input;
  return {
    check: "hallucination_risk",
    severity: "info",
    details: "pass (stub)",
  };
}

// §10.2 compliance_keyword check — STUB
// TODO(§21.10): real implementation in Part 5 hallucination defense work.
// Full implementation: detect medical, legal, and financial advice patterns
// that violate §9.7 platform constraints. Action: escalate (severity: critical).

import type { CheckInput, SupervisorFinding } from "../types";

export function checkComplianceKeyword(input: CheckInput): SupervisorFinding {
  void input;
  return {
    check: "compliance_keyword",
    severity: "info",
    details: "pass (stub)",
  };
}

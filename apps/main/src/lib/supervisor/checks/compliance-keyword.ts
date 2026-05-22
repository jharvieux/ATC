// §10.2 compliance_keyword — deterministic lexical detector for advice
// patterns the persona is prohibited from giving per §9.7 platform constraints
// (medical, legal, definitive financial advice).
//
// This is a layered defense. PLATFORM_CONSTRAINTS already forbids these in the
// persona system prompt; this check catches drift when the persona issues
// advice anyway. It is intentionally conservative — false positives drive up
// regen cost. The patterns target high-confidence advice-giving phrasing.
//
// Action on hit: severity 'critical' → run-supervisor.ts escalates the
// conversation (no regen — let a human take over).

import type { CheckInput, SupervisorFinding } from "../types";

interface Pattern {
  re: RegExp;
  category: "medical" | "legal" | "financial";
}

const PATTERNS: Pattern[] = [
  // Medical — phrasings that frame the assistant as making a clinical recommendation
  { re: /\byou should (take|stop taking|increase|decrease) (your )?(medication|insulin|dose)\b/i, category: "medical" },
  { re: /\b(diagnos\w+|prescrib\w+) (you|your)\b/i, category: "medical" },
  { re: /\bsafe to (fly|travel) with (your )?(condition|illness|symptoms)\b/i, category: "medical" },
  // Legal — definitive legal interpretations
  { re: /\bthis (is|would be) legally (binding|enforceable|valid|invalid)\b/i, category: "legal" },
  { re: /\byou (have|have no) (a )?(legal )?right to (sue|refund|compensation)\b/i, category: "legal" },
  { re: /\byou should (sue|file (a )?lawsuit|press charges)\b/i, category: "legal" },
  // Financial — definitive investment/tax advice
  { re: /\byou should (invest|put your money) in\b/i, category: "financial" },
  { re: /\bthis (counts|qualifies) as a (tax )?deduction\b/i, category: "financial" },
];

export function checkComplianceKeyword(input: CheckInput): SupervisorFinding {
  const hits: string[] = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(input.candidate_response);
    if (m) hits.push(`${p.category}: "${m[0]}"`);
  }

  if (hits.length === 0) {
    return {
      check: "compliance_keyword",
      severity: "info",
      details: "no compliance-keyword hits",
    };
  }
  return {
    check: "compliance_keyword",
    severity: "critical",
    details: `compliance violation: ${hits.slice(0, 2).join(" | ")}`,
  };
}

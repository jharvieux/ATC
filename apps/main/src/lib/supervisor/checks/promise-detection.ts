// §10.2 promise_detection check — REAL (lexical)
//
// Catches over-commitment phrases that could create legal/commercial liability.
// The soft-rewrite step (replacing the detected phrase with hedged language)
// is a runtime concern handled by Part 5; this check just flags the presence.
//
// Pattern rationale: each phrase represents a commitment stronger than the
// platform allows. Personas must use hedged language ("typically available",
// "usually included") per §9.4 anti-instructions.
//
// Action on flag: §10.2 says "Rewrite to hedged language" (severity: warning,
// not critical — regeneration is attempted if budget allows).

import type { CheckInput, SupervisorFinding } from "../types";

// Hand-curated list of over-commitment phrases per §10.2.
// Extend with operator input as production patterns emerge.
const PROMISE_PATTERNS: RegExp[] = [
  /\bguaranteed?\b/i,
  /\bI assure you\b/i,
  /\bI promise\b/i,
  /\bwithout (a )?doubt\b/i,
  /\b100%\s*(certain|sure|guaranteed)\b/i,
  /\bwill (definitely|certainly|absolutely)\b/i,
  /\byou (will|can) definitely\b/i,
  /\balways available\b/i,
  /\bnever (been|will be) (a problem|an issue|unavailable)\b/i,
  /\brest assured\b/i,
];

export function checkPromiseDetection(input: CheckInput): SupervisorFinding {
  for (const pattern of PROMISE_PATTERNS) {
    const match = pattern.exec(input.candidate_response);
    if (match) {
      return {
        check: "promise_detection",
        severity: "warning",
        details: `Over-commitment phrase detected: "${match[0]}"`,
      };
    }
  }
  return {
    check: "promise_detection",
    severity: "info",
    details: "No over-commitment phrases detected",
  };
}

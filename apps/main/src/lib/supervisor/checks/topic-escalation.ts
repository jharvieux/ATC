// §21.10 Layer 8 — escalation safety net (filed under topic_escalation slot
// for backward compatibility with §10.2's named check list).
//
// Fires when ALL of the following hold:
//   1. Sensitive intent: the user message intent is
//      medical | accessibility | legal | dietary | contractual.
//   2. Low retrieved-chunk confidence: the maximum chunk composite_confidence
//      across all retrieved chunks is < 0.5 (or no chunks at all).
//   3. The persona has NOT already offered human handoff in the last 3 turns
//      (recent_escalation_offered === false).
//   4. The persona does not specialize in this sensitive area
//      (persona_specializes_in_sensitive === false / undefined).
//
// Result severity 'warning' → regen with "suggest human handoff" instruction.

import type { CheckInput, SupervisorFinding } from "../types";

const SENSITIVE_INTENTS = new Set([
  "medical",
  "accessibility",
  "legal",
  "dietary",
  "contractual",
]);

const SENSITIVE_CATEGORIES = SENSITIVE_INTENTS;

interface RetrievedChunkShape {
  scoring?: { composite_confidence?: number };
}

export function checkTopicEscalation(input: CheckInput): SupervisorFinding {
  const intent = input.entities?.intent ?? "";
  const categoriesHint = input.entities?.categories_hint ?? [];

  const isSensitive =
    SENSITIVE_INTENTS.has(intent) ||
    categoriesHint.some((c) => SENSITIVE_CATEGORIES.has(c));

  if (!isSensitive) {
    return {
      check: "topic_escalation",
      severity: "info",
      details: "intent is not sensitive",
    };
  }

  if (input.persona_specializes_in_sensitive === true) {
    return {
      check: "topic_escalation",
      severity: "info",
      details: "persona specializes in sensitive topic — escalation not required",
    };
  }

  const chunks = (input.retrieved_chunks ?? []) as RetrievedChunkShape[];
  const maxConfidence = chunks.reduce<number>((max, c) => {
    const v = c.scoring?.composite_confidence ?? 0;
    return v > max ? v : max;
  }, 0);

  if (maxConfidence >= 0.5) {
    return {
      check: "topic_escalation",
      severity: "info",
      details: `sensitive intent but max chunk confidence ${maxConfidence.toFixed(2)} ≥ 0.5`,
    };
  }

  if (input.recent_escalation_offered === true) {
    return {
      check: "topic_escalation",
      severity: "info",
      details: "sensitive intent with low confidence, but escalation already offered recently",
    };
  }

  return {
    check: "topic_escalation",
    severity: "warning",
    details: `sensitive intent '${intent || categoriesHint.join(",")}' with low chunk confidence (${maxConfidence.toFixed(2)}); suggest human handoff`,
  };
}

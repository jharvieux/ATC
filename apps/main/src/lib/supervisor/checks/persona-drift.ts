// §10.2 persona_drift — deterministic v1.
//
// Detects responses that read as if a DIFFERENT persona is replying:
//   1. "I am [name]" / "my name is [name]" / "as [name]" — uses ANY name
//      other than what the active persona is supposed to use.
//   2. "as an AI language model" / "I'm a large language model" — explicit
//      model self-references break character per §9.1.
//   3. The response refuses to play the persona ("I cannot pretend to be").
//
// The check is intentionally narrow; richer style-comparison (compare voice
// against persona base block via Haiku) is a future iteration and is the
// reason this stub was filed under §21.10 in BP11.

import type { CheckInput, SupervisorFinding } from "../types";

const MODEL_SELF_REFERENCE_PATTERNS: RegExp[] = [
  /\bas an? (?:AI )?(large )?language model\b/i,
  /\bI(?:'| a)m (?:an? )?(?:AI|chatbot|language model)\b/i,
  /\bI was (?:trained|created|developed) by (?:Anthropic|OpenAI)\b/i,
];

const PERSONA_REFUSAL_PATTERNS: RegExp[] = [
  /\bI (?:cannot|can't) (?:pretend|roleplay|play)\b/i,
  /\bI (?:do not|don't) have a (?:real )?(?:name|persona|character)\b/i,
];

// Catches "I'm [Some Name]" or "my name is [Some Name]" where the name is
// likely a person-name token (Capitalized word). Used to flag when the model
// invents a different identity than the active persona; the actual identity
// match is left to the chat handler (which knows the active persona).
const SELF_INTRODUCTION_PATTERN = /\b(?:I(?:'| a)m|my name is|I am)\s+([A-Z][a-zA-Z]{2,})\b/g;

const PERSONA_NAME_TOKENS = new Set([
  "Marcus", "Marco", "Priya", "Dave", "Captain", "Maya", "Jenny",
]);

export function checkPersonaDrift(input: CheckInput): SupervisorFinding {
  const text = input.candidate_response;

  for (const p of MODEL_SELF_REFERENCE_PATTERNS) {
    const m = p.exec(text);
    if (m) {
      return {
        check: "persona_drift",
        severity: "warning",
        details: `model-self-reference: "${m[0]}"`,
      };
    }
  }

  for (const p of PERSONA_REFUSAL_PATTERNS) {
    const m = p.exec(text);
    if (m) {
      return {
        check: "persona_drift",
        severity: "warning",
        details: `persona refusal: "${m[0]}"`,
      };
    }
  }

  // Inventing a new name not on the known persona roster.
  let im: RegExpExecArray | null;
  SELF_INTRODUCTION_PATTERN.lastIndex = 0;
  while ((im = SELF_INTRODUCTION_PATTERN.exec(text)) !== null) {
    const name = im[1];
    if (!name) continue;
    if (!PERSONA_NAME_TOKENS.has(name)) {
      return {
        check: "persona_drift",
        severity: "warning",
        details: `unknown persona self-introduction: "${im[0]}"`,
      };
    }
  }

  return {
    check: "persona_drift",
    severity: "info",
    details: "no drift signals",
  };
}

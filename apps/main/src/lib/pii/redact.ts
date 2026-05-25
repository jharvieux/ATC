// §25.1 / 2026-05-25 audit pass 2 Finding 1 — deterministic PII redaction.
//
// Why this exists:
//   Customer-supplied chat text is shipped to Anthropic and persisted in
//   `messages.content`. The audit flagged that anonymous customers can
//   paste SSNs, credit-card numbers, and other sensitive identifiers,
//   which then leave the platform to a sub-processor AND sit in the DB
//   indefinitely. Material under GDPR / CCPA / state privacy laws.
//
// Design choices:
//   - Conservative regex set. We only redact patterns where false
//     positives are rare AND legitimate chat use is rare: SSNs, credit
//     cards (Luhn-validated), IBANs, passport-with-context.
//   - We DELIBERATELY do NOT redact: email addresses (customers share
//     their own all the time), phone numbers (likewise), generic
//     birthdates, addresses.
//   - Replace in-place with `[REDACTED_<KIND>]` placeholders. Operators
//     reading transcripts see what got redacted and can audit; we never
//     persist or log the raw matched text.
//   - Returns hit counts by kind so callers can emit metrics without the
//     PII itself.
//
// Run this BOTH at the entry to the LLM call AND just before the DB
// insert in /api/chat/route.ts. Two redactions of the same already-
// redacted text are a no-op (placeholders don't match the patterns).

export type PiiKind = "ssn" | "credit_card" | "iban" | "passport";

export interface RedactionResult {
  redacted: string;
  hits: Record<PiiKind, number>;
}

// SSN: NNN-NN-NNNN with separators (`-`, `.`, ` `). Reject the
// "000-00-0000" / "9NN-..." sentinel patterns to reduce false positives
// on log/template content.
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}[-.\s](?!00)\d{2}[-.\s](?!0000)\d{4}\b/g;

// Credit card: 13–19 digits possibly separated by spaces / dashes.
// Validate each match with Luhn to keep false positives low.
const CC_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

// IBAN: 2 letters + 2 check digits + 11-30 alphanumeric. ISO 13616.
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

// Passport: only redact a 6-9 alphanumeric token when the word
// "passport" appears within 40 chars before or after. Keeps false
// positives near zero (passport numbers look like generic IDs).
const PASSPORT_CONTEXT_BEFORE =
  /\bpassport(?:\s+(?:number|no\.?|#))?\s*[:#-]?\s*([A-Z0-9]{6,9})\b/gi;
const PASSPORT_CONTEXT_AFTER =
  /\b([A-Z0-9]{6,9})\s+(?:is\s+(?:my|the)\s+)?passport(?:\s+number)?\b/gi;

function passesLuhn(digits: string): boolean {
  const clean = digits.replace(/[^\d]/g, "");
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let n = parseInt(clean[i]!, 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactPii(input: string): RedactionResult {
  const hits: Record<PiiKind, number> = {
    ssn: 0,
    credit_card: 0,
    iban: 0,
    passport: 0,
  };
  if (!input || typeof input !== "string") {
    return { redacted: input ?? "", hits };
  }

  let out = input;

  // SSN — straightforward replace.
  out = out.replace(SSN_PATTERN, () => {
    hits.ssn++;
    return "[REDACTED_SSN]";
  });

  // Credit card — Luhn-validate each match before replacing.
  out = out.replace(CC_PATTERN, (match) => {
    if (passesLuhn(match)) {
      hits.credit_card++;
      return "[REDACTED_CREDIT_CARD]";
    }
    return match;
  });

  // IBAN — straightforward replace.
  out = out.replace(IBAN_PATTERN, () => {
    hits.iban++;
    return "[REDACTED_IBAN]";
  });

  // Passport — context-sensitive. Two patterns: "passport: ABC123" and
  // "ABC123 is my passport". Replace only the captured token.
  out = out.replace(PASSPORT_CONTEXT_BEFORE, (full, token: string) => {
    hits.passport++;
    return full.replace(token, "[REDACTED_PASSPORT]");
  });
  out = out.replace(PASSPORT_CONTEXT_AFTER, (full, token: string) => {
    hits.passport++;
    return full.replace(token, "[REDACTED_PASSPORT]");
  });

  return { redacted: out, hits };
}

/**
 * Returns true iff any PII was detected. Useful for emitting a metric
 * without persisting the matched substrings.
 */
export function hasPii(input: string): boolean {
  const { hits } = redactPii(input);
  return Object.values(hits).some((n) => n > 0);
}

/**
 * Total hit count across all kinds. For aggregate logging without
 * exposing what was redacted.
 */
export function totalHits(hits: Record<PiiKind, number>): number {
  return Object.values(hits).reduce((a, b) => a + b, 0);
}

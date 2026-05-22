// §6.11 / §22.4 — Zero-tolerance PII pre-filter (regex pass)
//
// Detects: passport numbers, credit card numbers (Luhn-validated), SSNs.
// A positive match → quarantine before any further processing.
// The Haiku redaction pass for tolerable PII (names, emails, phones) is a
// separate step — TODO(§22.4-haiku-redaction).
//
// Passport patterns cover US, UK, Canada, and EU common formats.
// Credit card regex catches 13-19 digit card-like sequences; Luhn check
// eliminates numeric false positives (e.g., order IDs, ISBN-13).

export type ZeroToleranceCategory = "passport" | "credit_card" | "ssn";

export type PiiDetectionResult = {
  detected: boolean;
  categories: ZeroToleranceCategory[];
};

// ── Passport patterns ────────────────────────────────────────────────────────

// US: starts with letter, 8 alphanum chars (e.g. A12345678)
const US_PASSPORT = /\b[A-Z][0-9]{8}\b/;

// UK: 2 letters + 7 digits (e.g. AB1234567)
const UK_PASSPORT = /\b[A-Z]{2}[0-9]{7}\b/;

// Canada: 2 letters + 6 digits (e.g. AB123456)
const CA_PASSPORT = /\b[A-Z]{2}[0-9]{6}\b/;

// EU generic: varied — 1-2 letters followed by 6-8 digits
const EU_PASSPORT = /\b[A-Z]{1,2}[0-9]{6,8}\b/;

// Machine-readable zone signature (presence of << in text is a strong signal)
const MRZ_PATTERN = /[A-Z0-9<]{9}<<[A-Z0-9<]+/;

function detectPassport(text: string): boolean {
  const upper = text.toUpperCase();
  return (
    MRZ_PATTERN.test(upper) ||
    US_PASSPORT.test(upper) ||
    UK_PASSPORT.test(upper) ||
    CA_PASSPORT.test(upper) ||
    EU_PASSPORT.test(upper)
  );
}

// ── Credit card (Luhn-validated) ─────────────────────────────────────────────

// Matches 13-19 digit sequences, optionally separated by spaces or hyphens.
const CARD_CANDIDATE = /\b(?:\d[ -]?){13,18}\d\b/g;

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits.charAt(i), 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function detectCreditCard(text: string): boolean {
  const candidates = text.match(CARD_CANDIDATE) ?? [];
  for (const raw of candidates) {
    const digits = raw.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
      return true;
    }
  }
  return false;
}

// ── SSN (US) ─────────────────────────────────────────────────────────────────

// Formats: 123-45-6789, 123 45 6789 (both separators must be the same character).
// No-separator form (123456789) is intentionally excluded — too many false positives
// from order IDs, phone numbers, etc. Context-free 9-digit sequences need human review.
// Excludes obviously fake values (all-zero area/group codes, 9xx ITINs).
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}([-\s])(?!00)\d{2}\1(?!0000)\d{4}\b/;

function detectSSN(text: string): boolean {
  return SSN_PATTERN.test(text);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function detectZeroTolerancePII(text: string): PiiDetectionResult {
  const categories: ZeroToleranceCategory[] = [];

  if (detectPassport(text)) categories.push("passport");
  if (detectCreditCard(text)) categories.push("credit_card");
  if (detectSSN(text)) categories.push("ssn");

  return { detected: categories.length > 0, categories };
}

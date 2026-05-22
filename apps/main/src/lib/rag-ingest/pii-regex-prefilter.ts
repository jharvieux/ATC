// §22.4 / §22.4a — Zero-tolerance PII regex prefilter (main-app side).
//
// Mirrors the detector in apps/rag/src/lib/pii/regex-prefilter.ts. Main-app
// runs this BEFORE forwarding content to the RAG service so quarantine
// decisions (and the §22.4a aggregation) happen in the tenant-facing flow.
// The RAG service runs its own copy as defense in depth.
//
// Categories detected: passport, credit_card, ssn.

export type ZeroToleranceCategory = "passport" | "credit_card" | "ssn";

export interface PiiDetectionResult {
  detected: boolean;
  categories: ZeroToleranceCategory[];
}

// Passport patterns (US, UK, Canada, EU generic, MRZ).
const US_PASSPORT = /\b[A-Z][0-9]{8}\b/;
const UK_PASSPORT = /\b[A-Z]{2}[0-9]{7}\b/;
const CA_PASSPORT = /\b[A-Z]{2}[0-9]{6}\b/;
const EU_PASSPORT = /\b[A-Z]{1,2}[0-9]{6,8}\b/;
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

// Credit card: 13–19 digit sequences with optional spaces/dashes, Luhn-validated.
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

// SSN: requires matching separator (backreference) to exclude zip+4 false
// positives. No-separator 9-digit form deliberately excluded — too many
// numeric false positives.
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}([-\s])(?!00)\d{2}\1(?!0000)\d{4}\b/;

function detectSSN(text: string): boolean {
  return SSN_PATTERN.test(text);
}

export function detectZeroTolerancePII(text: string): PiiDetectionResult {
  const categories: ZeroToleranceCategory[] = [];
  if (detectPassport(text)) categories.push("passport");
  if (detectCreditCard(text)) categories.push("credit_card");
  if (detectSSN(text)) categories.push("ssn");
  return { detected: categories.length > 0, categories };
}

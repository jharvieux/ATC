/**
 * BP31 §32.7.6 — PII redaction for bug-report content before GitHub.
 *
 * Two-tier model:
 *
 *   1. **Zero-tolerance regex pass.** SSN, Luhn-validating credit card,
 *      passport-number patterns. On match the caller MUST quarantine the
 *      submission (`github_issue_state='quarantined'`), MUST NOT create
 *      the GitHub issue, and MUST alert platform admin.
 *
 *   2. **Tolerable redaction pass.** Names, emails, phone numbers are
 *      replaced with `[REDACTED-NAME]` / `[REDACTED-EMAIL]` /
 *      `[REDACTED-PHONE]` markers. Per §32.13.1 the redacted form is
 *      what gets persisted in `bug_submissions` AND what gets posted to
 *      GitHub; the raw form is discarded.
 *
 * BP31 Phase A ships tier 1 (regex zero-tolerance) only. The Haiku-driven
 * tier 2 pass is deferred per the BP31 cost-deferral decision (D-065) —
 * `redactTolerablePii` ships as a sync pass-through stub with a TODO
 * marker. Wire to the §22.4 Haiku pipeline once an operator decides to
 * burn Anthropic budget per bug submission.
 *
 * Both passes are PURE functions — no DB, no network, no async — so they
 * can be invoked from inside the GitHub-issue creation flow without
 * adding latency or failure modes. The zero-tolerance custom error
 * carries enough structure that the caller can write the audit row.
 */

/** Fields the bug-flow gathers; each is run through both passes. */
export const BUG_FIELDS = [
  "where_in_platform",
  "actual_behavior",
  "expected_behavior",
  "steps_to_reproduce",
] as const;
export type BugField = (typeof BUG_FIELDS)[number];

export type ZeroToleranceKind = "ssn" | "credit_card" | "passport";

export interface ZeroToleranceHit {
  field: BugField;
  kind: ZeroToleranceKind;
  /**
   * The literal token that matched, redacted to its last-4 only so the
   * audit row can carry forensic context without re-leaking the secret.
   * (Operator reading the audit_log row needs to know WHICH SSN-shaped
   *  string triggered the quarantine — last-4 is enough.)
   */
  redacted_excerpt: string;
}

/**
 * Thrown by the GitHub-issue creation flow when any zero-tolerance match
 * fires. Caller catches this, writes the quarantine state, and surfaces
 * the friendly user message documented in §32.7.6 + §32.7.5.
 */
export class PIIZeroToleranceQuarantineError extends Error {
  readonly hits: readonly ZeroToleranceHit[];
  constructor(hits: readonly ZeroToleranceHit[]) {
    const kinds = [...new Set(hits.map((h) => h.kind))].join(", ");
    super(`PII zero-tolerance quarantine: ${kinds}`);
    this.name = "PIIZeroToleranceQuarantineError";
    this.hits = hits;
  }
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * SSN — 3-2-4 with explicit separators (space or hyphen) so the pattern
 * doesn't false-match a 9-digit run like a phone number or order ID.
 * Boundary anchors avoid partial matches inside longer digit runs.
 */
const SSN_RE = /(?<![\d])(\d{3})[-\s](\d{2})[-\s](\d{4})(?![\d])/g;

/**
 * Credit card — 13-19 contiguous digits, optionally separated by spaces or
 * hyphens (we strip those before Luhn). The boundary checks avoid matching
 * a 16-digit subset of a longer numeric run.
 */
const CC_CANDIDATE_RE = /(?<![\d])((?:\d[ -]?){12,18}\d)(?![\d])/g;

/**
 * Passport — common US/UK shapes: 1 letter + 8 digits, or 9 digits, or 2
 * letters + 7 digits. Word boundaries on both sides.
 */
const PASSPORT_RE = /\b(?:[A-Z]\d{8}|[A-Z]{2}\d{7}|\d{9})\b/g;

/** Email — practical pattern; not RFC-perfect but catches the obvious. */
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** Phone — North-American 10-digit shapes; the spec doesn't require global. */
const PHONE_RE = /(?<![\d])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?![\d])/g;

// ---------------------------------------------------------------------------
// Luhn — credit card sanity check so we don't quarantine random 16-digit runs.
// ---------------------------------------------------------------------------

export function luhnValid(digits: string): boolean {
  const d = digits.replace(/[^\d]/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Zero-tolerance scanner
// ---------------------------------------------------------------------------

function tail4(s: string): string {
  const stripped = s.replace(/[^A-Za-z0-9]/g, "");
  return stripped.length <= 4 ? "****" : `****${stripped.slice(-4)}`;
}

/**
 * Scan one field's value for any zero-tolerance match.
 * Returns every hit (so the audit row can record more than one if present);
 * the caller throws if the returned array is non-empty.
 */
export function scanZeroTolerance(field: BugField, value: string | null | undefined): ZeroToleranceHit[] {
  if (!value) return [];
  const hits: ZeroToleranceHit[] = [];

  // SSN
  SSN_RE.lastIndex = 0;
  for (const m of value.matchAll(SSN_RE)) {
    hits.push({ field, kind: "ssn", redacted_excerpt: tail4(m[0]) });
  }

  // Credit card (Luhn-validated)
  CC_CANDIDATE_RE.lastIndex = 0;
  for (const m of value.matchAll(CC_CANDIDATE_RE)) {
    const candidate = m[1] ?? m[0];
    if (luhnValid(candidate)) {
      hits.push({ field, kind: "credit_card", redacted_excerpt: tail4(candidate) });
    }
  }

  // Passport — only fires on the patterned shape AND when the context word
  // "passport" appears nearby OR the shape is the 2-letter + 7-digit form
  // (high confidence even without context). The bare 9-digit shape is a
  // huge false-positive risk (every order ID, every booking ref).
  PASSPORT_RE.lastIndex = 0;
  for (const m of value.matchAll(PASSPORT_RE)) {
    const matched = m[0];
    const isHighConfidenceShape = /^[A-Z]\d{8}$/.test(matched) || /^[A-Z]{2}\d{7}$/.test(matched);
    if (isHighConfidenceShape) {
      hits.push({ field, kind: "passport", redacted_excerpt: tail4(matched) });
      continue;
    }
    // 9-digit shape — only count it if the word "passport" appears within
    // 40 chars of the match (a rough context window).
    const idx = m.index ?? 0;
    const ctxStart = Math.max(0, idx - 40);
    const ctxEnd = Math.min(value.length, idx + matched.length + 40);
    const context = value.slice(ctxStart, ctxEnd).toLowerCase();
    if (context.includes("passport")) {
      hits.push({ field, kind: "passport", redacted_excerpt: tail4(matched) });
    }
  }

  return hits;
}

/**
 * Scan an entire bug submission's free-text fields.
 * Throws PIIZeroToleranceQuarantineError if any hit is found.
 */
export function assertNoZeroTolerancePii(
  submission: Partial<Record<BugField, string | null | undefined>>,
): void {
  const allHits: ZeroToleranceHit[] = [];
  for (const field of BUG_FIELDS) {
    allHits.push(...scanZeroTolerance(field, submission[field]));
  }
  if (allHits.length > 0) {
    throw new PIIZeroToleranceQuarantineError(allHits);
  }
}

// ---------------------------------------------------------------------------
// Tolerable redaction (deferred — pass-through stub)
// ---------------------------------------------------------------------------

/**
 * BP31 Phase A scope: regex-only tolerable redaction. The spec calls for a
 * Haiku pass to catch names + context-sensitive emails/phones; that's
 * deferred to keep per-submission cost at zero until the operator opts
 * in. This regex pass catches the obvious shape-matches; sophisticated
 * PII (names without context, obfuscated emails) flows through.
 *
 * Returns the input string with any matched tolerable PII replaced by
 * `[REDACTED-EMAIL]` / `[REDACTED-PHONE]`. The Haiku-driven `[REDACTED-NAME]`
 * substitution is deferred.
 *
 * TODO(haiku-pii-redaction): wire to the §22.4 Haiku PII pipeline once
 * the operator approves the per-submission Anthropic cost.
 */
export function redactTolerablePii(input: string | null | undefined): string {
  if (!input) return "";
  let out = input.replace(EMAIL_RE, "[REDACTED-EMAIL]");
  out = out.replace(PHONE_RE, "[REDACTED-PHONE]");
  return out;
}

/**
 * Apply the tolerable-PII redaction to every free-text field of a bug
 * submission and return a shallow copy with the same shape.
 */
export function redactSubmission<T extends Partial<Record<BugField, string | null | undefined>>>(
  submission: T,
): T {
  const out = { ...submission } as Record<string, string | null | undefined> & T;
  for (const field of BUG_FIELDS) {
    const v = submission[field];
    if (typeof v === "string") {
      (out as Record<string, string | null | undefined>)[field] = redactTolerablePii(v);
    }
  }
  return out;
}

// BP34 §34.2.2 — Email import trigger detection.
//
// A Gmail message qualifies for import parsing when either:
//   - The subject line starts with the word "IMPORT" (any case + trailing
//     punctuation), or
//   - The first non-empty line of the body starts with the word "IMPORT".
//
// Word-boundary check guarantees IMPORTANT, IMPORTED, IMPORTING do NOT
// match — only the standalone word "IMPORT" followed by whitespace,
// punctuation, or end-of-line triggers parsing.
//
// This runs as the FIRST step of inbound Gmail message processing,
// before persona response logic (§9). Result is logged on the message
// row for debuggability.

export const IMPORT_TRIGGER = /^\s*IMPORT\b/i;

/**
 * Returns true iff the message qualifies for inbound-import parsing.
 * Caller is responsible for tier-gating (only Pro+ tenants get email
 * import — see §34.9) and Gmail-health-gating (skip when integration
 * is unhealthy — see §34.2.4).
 */
export function qualifiesForImport(subject: string, body: string): boolean {
  if (IMPORT_TRIGGER.test(subject)) return true;
  const firstNonEmpty = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstNonEmpty ? IMPORT_TRIGGER.test(firstNonEmpty) : false;
}

import { timingSafeEqual } from "node:crypto";

// Constant-time string equality for comparing a caller-supplied secret
// (e.g. a bearer token) against a high-value env secret. V8's `===`/`!==`
// short-circuits on the first byte mismatch, which is a textbook
// timing-attack primitive for byte-by-byte secret recovery (D-091, #397).
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Burn comparable CPU so a length mismatch doesn't leak via timing. Pass
    // `ab` twice on purpose: timingSafeEqual throws unless both args are the
    // same byteLength, and self-comparison satisfies that for any length
    // (including 0). Changing this to timingSafeEqual(ab, bb) would throw here.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

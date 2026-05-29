import { timingSafeEqual } from "node:crypto";

// Constant-time string equality for comparing a caller-supplied secret
// (e.g. a bearer token) against a high-value env secret. V8's `===`/`!==`
// short-circuits on the first byte mismatch, which is a textbook
// timing-attack primitive for byte-by-byte secret recovery (D-091, #397).
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Burn a comparable amount of CPU so a length mismatch doesn't leak via timing.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

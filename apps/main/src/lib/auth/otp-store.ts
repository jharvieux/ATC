// §17.2 — In-process OTP store for the no-email recovery flow (MS, FB, any
// provider that yields a null email).
//
// `attempts` caps brute force: a 6-digit code is 1-in-1M, so without a cap
// an attacker with a valid OAuth session of their own could try a victim's
// email + a code-guess in a tight loop until they bind their auth identity
// to the victim's email. The verify route counts each wrong submission and
// rejects after MAX_ATTEMPTS.
//
// NOTE: In-memory storage works only within a single serverless function
// instance. For multi-instance / production deployments, replace with a
// Redis-backed store (REDIS_URL already used by the RAG service).
// Acceptable for Phase 1 launch with low-concurrency OTP flows.

export const MAX_OTP_ATTEMPTS = 5;

export interface OtpEntry {
  code: string;
  expires: number;
  attempts: number;
}

export const OTP_STORE = new Map<string, OtpEntry>();

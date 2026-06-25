// §17.2 — In-process OTP store for the no-email recovery flow (MS, FB, any
// provider that yields a null email).
//
// F-auth-01 (#1379): the store is keyed by the AUTHENTICATED auth_user_id, not
// by the typed email. The prompt route requires a session before minting, so an
// OTP can only be created and consumed by the same logged-in identity — an
// unauthenticated party can't mint codes at all, and the brute-force `attempts`
// budget can't be reset by re-requesting a code (the prompt route carries the
// prior count forward into the new entry).
//
// `attempts` caps brute force: a 6-digit code is 1-in-1M, so without a cap an
// attacker with their own valid OAuth session could try a victim's email + a
// code-guess in a loop. The verify route counts each wrong submission and
// rejects after MAX_ATTEMPTS. The actual identity binding is additionally
// guarded by auth.users' unique-email constraint (updateUserById fails if the
// email already belongs to another account).
//
// NOTE: In-memory storage works only within a single serverless function
// instance — acceptable for the low-concurrency §17.2 OTP flow (operator call,
// #1379). Multi-instance Redis upgrade tracked in #735.

export const MAX_OTP_ATTEMPTS = 5;

export interface OtpEntry {
  code: string;
  /** The email this code was minted to verify (the _ms_pending_email cookie). */
  email: string;
  expires: number;
  attempts: number;
}

// Keyed by auth_user_id (the session identity), NOT by email.
export const OTP_STORE = new Map<string, OtpEntry>();

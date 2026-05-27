// D-091 P1 #38 — Svix signature verification for Resend webhooks.
//
// Resend uses Svix's signing scheme:
//   HMAC-SHA256(secret_bytes, `${svix-id}.${svix-timestamp}.${body}`)
//   then base64-encode the HMAC output.
//   Header `svix-signature` may carry multiple space-separated entries
//   like `v1,<base64> v1,<base64>` — any match is valid (key rotation).
// The secret is stored as `whsec_<base64-of-secret-bytes>`; strip the
// prefix and base64-decode to get the raw key material.
//
// Reject messages older than 5 minutes per Svix's replay-protection guidance.

import { createHmac, timingSafeEqual } from "node:crypto";

const SVIX_TOLERANCE_SECONDS = 5 * 60;

function decodeSecret(secret: string): Buffer {
  const stripped = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(stripped, "base64");
}

export interface VerifyResendSignatureArgs {
  body: string;
  msgId: string | null;
  timestamp: string | null;
  signatureHeader: string | null;
  secret: string;
  /** Test seam — defaults to Date.now(). */
  nowSeconds?: number;
}

export function verifyResendSignature(args: VerifyResendSignatureArgs): boolean {
  const { body, msgId, timestamp, signatureHeader, secret } = args;
  if (!msgId || !timestamp || !signatureHeader) return false;

  // Reject messages outside the tolerance window — replay protection.
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(now - tsNum) > SVIX_TOLERANCE_SECONDS) return false;

  try {
    const key = decodeSecret(secret);
    const signedContent = `${msgId}.${timestamp}.${body}`;
    const expected = createHmac("sha256", key).update(signedContent).digest();

    // Header may carry multiple `v1,<base64>` entries separated by spaces.
    // Accept the request if ANY entry matches (timing-safe).
    for (const entry of signatureHeader.split(/\s+/)) {
      const [scheme, sig] = entry.split(",");
      if (scheme !== "v1" || !sig) continue;
      const actual = Buffer.from(sig, "base64");
      if (actual.length !== expected.length) continue;
      if (timingSafeEqual(expected, actual)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
